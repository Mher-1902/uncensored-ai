use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::BackendError;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn is_request_id(value: &str) -> bool {
    if value.len() != 36 || !value.bytes().enumerate().all(|(i, byte)| {
        if [8, 13, 18, 23].contains(&i) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    }) { return false; }
    value.as_bytes()[14] == b'4' && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub request_id: String,
    pub worker_id: String,
    pub worker_stopped: bool,
    pub outcome: String,
}

#[derive(Default)]
struct RecordState {
    prepared: bool,
    claimed: bool,
    proof: Option<Proof>,
}

pub struct Record {
    pub request_id: String,
    pub worker_id: String,
    pub expires_at: u64,
    pub cancellation: CancellationToken,
    state: Mutex<RecordState>,
    proof_tx: watch::Sender<Option<Proof>>,
}

impl Record {
    fn finish_locked(&self, state: &mut RecordState, worker_stopped: bool, outcome: &str) {
        if state.proof.is_some() { return; }
        let proof = Proof { request_id: self.request_id.clone(), worker_id: self.worker_id.clone(), worker_stopped, outcome: outcome.to_owned() };
        state.proof = Some(proof.clone());
        self.proof_tx.send_replace(Some(proof));
    }

    pub fn finish(&self, worker_stopped: bool, outcome: &str) {
        self.finish_locked(&mut self.state.lock().expect("receipt state lock"), worker_stopped, outcome);
    }
}

// The registry stores only opaque identities, deadlines and cleanup proof.
// Expiry never evicts active computation or claims that its worker stopped.
pub struct Registry {
    pub worker_id: String,
    records: Mutex<HashMap<String, Arc<Record>>>,
    limit: usize,
    shutdown: CancellationToken,
}

impl Default for Registry {
    fn default() -> Self { Self::new(Uuid::new_v4().to_string(), 1024) }
}

impl Registry {
    pub fn new(worker_id: String, limit: usize) -> Self {
        Self::with_shutdown(worker_id, limit, CancellationToken::new())
    }

    pub fn with_shutdown(worker_id: String, limit: usize, shutdown: CancellationToken) -> Self {
        Self { worker_id, records: Mutex::new(HashMap::new()), limit, shutdown }
    }

    fn register_locked(&self, records: &mut HashMap<String, Arc<Record>>, request_id: &str, expected_worker: &str, deadline: &str, now: u64) -> Result<Arc<Record>, BackendError> {
        if self.shutdown.is_cancelled() { return Err(BackendError::new(503, "The gateway is shutting down.")); }
        if !is_request_id(request_id) || !is_request_id(expected_worker) || deadline.len() != 13 || !deadline.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(BackendError::new(400, "Invalid request receipt."));
        }
        let expires_at = deadline.parse::<u64>().map_err(|_| BackendError::new(400, "Invalid request receipt."))?;
        if expected_worker != self.worker_id || expires_at <= now || expires_at > now.saturating_add(300_000) {
            return Err(BackendError::new(409, "The request receipt has expired."));
        }
        records.retain(|_, record| {
            let mut state = record.state.lock().expect("receipt state lock");
            if state.prepared && !state.claimed && record.expires_at <= now {
                record.cancellation.cancel();
                record.finish_locked(&mut state, true, "rejected");
            }
            !(state.proof.is_some() && record.expires_at <= now)
        });
        if records.contains_key(request_id) { return Err(BackendError::new(409, "This request was already received.")); }
        if records.len() >= self.limit { return Err(BackendError::new(503, "The server is busy. Please try again shortly.")); }
        let (proof_tx, _) = watch::channel(None);
        let record = Arc::new(Record { request_id: request_id.to_owned(), worker_id: self.worker_id.clone(), expires_at,
            cancellation: self.shutdown.child_token(), state: Mutex::new(RecordState::default()), proof_tx });
        records.insert(request_id.to_owned(), record.clone());
        Ok(record)
    }

    pub fn register(&self, request_id: &str, expected_worker: &str, deadline: &str) -> Result<Arc<Record>, BackendError> {
        self.register_locked(&mut self.records.lock().expect("registry lock"), request_id, expected_worker, deadline, now_ms())
    }

    pub fn prepare(&self, value: Value) -> Result<Value, BackendError> {
        if !has_keys(&value, &["deadline", "requestId", "workerId"]) { return Err(BackendError::new(400, "Invalid request receipt.")); }
        let request_id = string(&value, "requestId")?;
        let worker_id = string(&value, "workerId")?;
        let deadline = string(&value, "deadline")?;
        let mut records = self.records.lock().expect("registry lock");
        let record = self.register_locked(&mut records, request_id, worker_id, deadline, now_ms())?;
        record.state.lock().expect("receipt state lock").prepared = true;
        Ok(json!({"prepared":true,"requestId":request_id,"workerId":self.worker_id}))
    }

    pub fn claim(&self, request_id: &str, expected_worker: &str, deadline: &str) -> Result<Arc<Record>, BackendError> {
        let records = self.records.lock().expect("registry lock");
        let unavailable = || BackendError::new(409, "The prepared request is unavailable.");
        let record = records.get(request_id).filter(|_| expected_worker == self.worker_id).ok_or_else(unavailable)?;
        let mut state = record.state.lock().expect("receipt state lock");
        if !state.prepared || state.claimed || deadline != record.expires_at.to_string() || record.expires_at <= now_ms() { return Err(unavailable()); }
        state.claimed = true;
        Ok(record.clone())
    }

    pub async fn cancel(&self, value: Value, wait: Duration) -> Result<Value, BackendError> {
        if !(has_keys(&value, &["requestId", "workerId"]) || has_keys(&value, &["discard", "requestId", "workerId"]))
            || value.get("discard").is_some_and(|item| !item.is_boolean()) {
            return Err(BackendError::new(400, "Invalid request receipt."));
        }
        let request_id = string(&value, "requestId")?;
        let expected_worker = string(&value, "workerId")?;
        if !is_request_id(request_id) || !is_request_id(expected_worker) { return Err(BackendError::new(400, "Invalid request receipt.")); }
        let unknown = || json!({"requestId":request_id,"workerId":self.worker_id,"workerStopped":false});
        let record = {
            let mut records = self.records.lock().expect("registry lock");
            let Some(record) = records.get(request_id).filter(|_| expected_worker == self.worker_id).cloned() else { return Ok(unknown()); };
            record.cancellation.cancel();
            let mut state = record.state.lock().expect("receipt state lock");
            if state.prepared && !state.claimed {
                record.finish_locked(&mut state, true, "rejected");
                if value.get("discard").and_then(Value::as_bool) == Some(true) { records.remove(request_id); }
            }
            drop(state);
            record
        };
        let mut proof = record.proof_tx.subscribe();
        let result = tokio::time::timeout(wait, async {
            loop {
                let current = proof.borrow_and_update().clone();
                if let Some(value) = current { return value; }
                if proof.changed().await.is_err() { break; }
            }
            Proof { request_id: request_id.to_owned(), worker_id: self.worker_id.clone(), worker_stopped: false, outcome: "failed".to_owned() }
        }).await;
        Ok(match result { Ok(value) => serde_json::to_value(value).expect("serializable proof"), Err(_) => unknown() })
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, BackendError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| BackendError::new(400, "Invalid request receipt."))
}

fn has_keys(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == names.len() && names.iter().all(|key| object.contains_key(*key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_never_evicts_claimed_or_active_computation() {
        let worker = "22222222-2222-4222-8222-222222222222";
        let request = "11111111-1111-4111-8111-111111111111";
        let next = "33333333-3333-4333-8333-333333333333";
        let registry = Registry::new(worker.into(), 1);
        let clock = 1_777_777_777_777u64;
        let mut records = registry.records.lock().unwrap();
        let record = registry.register_locked(&mut records, request, worker, &(clock + 1).to_string(), clock).unwrap();
        assert!(registry.register_locked(&mut records, next, worker, &(clock + 1000).to_string(), clock + 2).is_err());
        assert!(!record.cancellation.is_cancelled(), "expiry alone never stops unknown active work");
        record.finish(false, "cancelled");
        assert!(registry.register_locked(&mut records, next, worker, &(clock + 1000).to_string(), clock + 2).is_ok());
        assert!(registry.register_locked(&mut records, request, worker, &(clock + 1).to_string(), clock + 2).is_err());
    }

    #[test]
    fn expired_unclaimed_preparation_is_rejected_and_removed() {
        let worker = "22222222-2222-4222-8222-222222222222";
        let request = "11111111-1111-4111-8111-111111111111";
        let next = "33333333-3333-4333-8333-333333333333";
        let registry = Registry::new(worker.into(), 1);
        let clock = 1_777_777_777_777u64;
        let mut records = registry.records.lock().unwrap();
        let record = registry.register_locked(&mut records, request, worker, &(clock + 1).to_string(), clock).unwrap();
        record.state.lock().unwrap().prepared = true;
        assert!(registry.register_locked(&mut records, next, worker, &(clock + 1000).to_string(), clock + 2).is_ok());
        assert!(record.cancellation.is_cancelled());
        let state = record.state.lock().unwrap();
        let proof = state.proof.as_ref().unwrap();
        assert!(proof.worker_stopped); assert_eq!(proof.outcome, "rejected");
    }
}
