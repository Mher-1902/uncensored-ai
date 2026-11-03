use std::{pin::Pin, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc}, task::{Context, Poll}, time::Duration};

use async_trait::async_trait;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}, response::Response, Router};
use futures_util::{stream, Stream};
use offscript_backend::{config::GatewayConfig, engine::{Engine, EngineStream, ModelEvent, Prepared}, gateway::router,
    registry::{is_request_id, now_ms, Registry}, request::{validate_request, ChatInput}, transport::{serve_with_config,TransportConfig}, BackendError};
use serde_json::{json, Value};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::{TcpListener,TcpStream},sync::{Notify, Semaphore},task::JoinHandle};
use tokio_util::{sync::CancellationToken,task::TaskTracker};
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "test_service_credential_12345678901234567890";
const ORIGIN: &str = "https://offscript.example.test";

struct FakeEngine {
    generations: AtomicUsize,
    disposals: AtomicUsize,
    active: Arc<AtomicBool>,
    prepare_active: AtomicBool,
    prepares: AtomicUsize,
    block_first_prepare: bool,
    prepare_entered: Notify,
    prepare_cancelled: Notify,
    prepare_release: Semaphore,
    hold_first: bool,
    block_first_cleanup: bool,
    cleanup_entered: Notify,
    cleanup_release: Semaphore,
    fail_disposal: usize,
}
impl FakeEngine {
    fn new(hold_first: bool, block_first_cleanup: bool, fail_disposal: usize) -> Arc<Self> {
        Arc::new(Self { generations: AtomicUsize::new(0), disposals: AtomicUsize::new(0), active: Arc::new(AtomicBool::new(false)),
            prepare_active: AtomicBool::new(false), prepares: AtomicUsize::new(0), block_first_prepare: false,
            prepare_entered: Notify::new(), prepare_cancelled: Notify::new(), prepare_release: Semaphore::new(0),
            hold_first, block_first_cleanup, cleanup_entered: Notify::new(), cleanup_release: Semaphore::new(0), fail_disposal })
    }
    fn blocking_prepare() -> Arc<Self> {
        let mut engine = Self::new(false, false, 0);
        Arc::get_mut(&mut engine).unwrap().block_first_prepare = true;
        engine
    }
}

struct NativeStream {
    inner: EngineStream,
    active: Arc<AtomicBool>,
}
impl Stream for NativeStream {
    type Item = Result<ModelEvent, BackendError>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> { self.inner.as_mut().poll_next(context) }
}
impl Drop for NativeStream {
    fn drop(&mut self) { self.active.store(false, Ordering::SeqCst); }
}

#[async_trait]
impl Engine for FakeEngine {
    async fn ready(&self) -> bool { true }
    async fn dispose(&self) -> bool {
        let call = self.disposals.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(!self.active.load(Ordering::SeqCst), "drop/cancel native transport before erasure");
        assert!(!self.prepare_active.load(Ordering::SeqCst), "wait for owned tokenization work before erasure proof");
        if call == 2 && self.block_first_cleanup {
            self.cleanup_entered.notify_one();
            self.cleanup_release.acquire().await.expect("cleanup gate").forget();
        }
        call != self.fail_disposal
    }
    async fn prepare(&self, input: &ChatInput, cancel: &CancellationToken) -> Result<Prepared, BackendError> {
        let call = self.prepares.fetch_add(1, Ordering::SeqCst) + 1;
        if self.block_first_prepare && call == 1 {
            self.prepare_active.store(true, Ordering::SeqCst);
            self.prepare_entered.notify_one();
            cancel.cancelled().await;
            self.prepare_cancelled.notify_one();
            self.prepare_release.acquire().await.expect("prepare quiescence gate").forget();
            self.prepare_active.store(false, Ordering::SeqCst);
        }
        if cancel.is_cancelled() { return Err(BackendError::new(499, "Request cancelled.")); }
        Ok(Prepared { input: input.clone(), prompt: "synthetic prompt".into(), input_tokens: vec![1, 2], output_budget: input.max_tokens, reasoning_budget: 0 })
    }
    async fn generate(&self, _prepared: Prepared, cancel: CancellationToken) -> Result<EngineStream, BackendError> {
        let generation = self.generations.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(!self.active.swap(true, Ordering::SeqCst), "only one native model request may be active");
        let hold = self.hold_first && generation == 1;
        let events: EngineStream = Box::pin(stream::unfold((0, cancel), move |(stage, cancel)| async move {
            let event = match stage {
                0 => ModelEvent::Data(json!({"choices":[{"delta":{"role":"assistant","content":"Synthetic reply","reasoning_content":"private thought"},"finish_reason":null}],"diagnostic":"never forward this"})),
                1 if hold => {
                    cancel.cancelled().await;
                    return None;
                }
                1 => ModelEvent::Data(json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}})),
                2 => ModelEvent::Done,
                _ => return None,
            };
            Some((Ok(event), (stage + 1, cancel)))
        }));
        Ok(Box::pin(NativeStream { inner: events, active: self.active.clone() }))
    }
}

fn app(engine: Arc<FakeEngine>) -> Router {
    router(GatewayConfig { access_token: Some(TOKEN.into()), origins: [ORIGIN.into()].into_iter().collect(), ..GatewayConfig::default() }, engine)
}

fn request(method: &str, path: &str, body: Value) -> Request<Body> {
    Request::builder().method(method).uri(path).header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json").header("x-offscript-client", "web")
        .body(Body::from(serde_json::to_vec(&body).unwrap())).unwrap()
}

fn chat_input() -> Value { json!({"messages":[{"role":"user","content":"Hello"}],"mode":"fast","maxTokens":256}) }

async fn disconnected_worker(shutdown_timeout:Duration) -> (Arc<FakeEngine>,CancellationToken,TaskTracker,JoinHandle<Result<(),BackendError>>) {
    let engine=FakeEngine::new(true,true,0);let shutdown=CancellationToken::new();let workers=TaskTracker::new();
    let app=router(GatewayConfig {access_token:Some(TOKEN.into()),shutdown:shutdown.clone(),workers:workers.clone(),..GatewayConfig::default()},engine.clone());
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
    let token=shutdown.clone();let tracking=workers.clone();
    let server=tokio::spawn(async move {serve_with_config(listener,app,token,TransportConfig {shutdown_timeout,..TransportConfig::default()},tracking).await});
    let body=chat_input().to_string();
    let request=format!("POST /api/chat HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nX-Offscript-Client: web\r\nContent-Length: {}\r\n\r\n{body}",body.len());
    let mut socket=TcpStream::connect(address).await.unwrap();socket.write_all(request.as_bytes()).await.unwrap();
    let mut headers=Vec::new();
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {let mut byte=[0u8;1];socket.read_exact(&mut byte).await.unwrap();headers.push(byte[0]);assert!(headers.len()<65536);if headers.ends_with(b"\r\n\r\n"){break;}}
    }).await.expect("streaming response started");
    assert!(String::from_utf8_lossy(&headers).contains("200 OK"));drop(socket);
    tokio::time::timeout(Duration::from_secs(3),engine.cleanup_entered.notified()).await.expect("disconnected worker reached native cleanup");
    assert_eq!(workers.len(),1);assert!(!engine.active.load(Ordering::SeqCst));
    (engine,shutdown,workers,server)
}

#[tokio::test]
async fn shutdown_waits_for_disconnected_model_worker_erasure_after_its_http_connection_ended() {
    let (engine,shutdown,workers,mut server)=disconnected_worker(Duration::from_secs(3)).await;
    shutdown.cancel();
    assert!(tokio::time::timeout(Duration::from_millis(50),&mut server).await.is_err(),"no sockets must not be mistaken for completed model cleanup");
    assert_eq!(workers.len(),1);engine.cleanup_release.add_permits(1);
    assert!(tokio::time::timeout(Duration::from_secs(3),server).await.expect("cleanup permits shutdown").unwrap().is_ok());
    assert!(workers.is_empty());assert_eq!(engine.disposals.load(Ordering::SeqCst),2);
}

#[tokio::test]
async fn disconnected_worker_cleanup_still_obeys_the_single_process_shutdown_deadline() {
    let (engine,shutdown,workers,server)=disconnected_worker(Duration::from_millis(100)).await;
    shutdown.cancel();
    let result=tokio::time::timeout(Duration::from_secs(3),server).await.expect("bounded worker shutdown").unwrap();
    assert!(result.is_err(),"an unconfirmed erase cannot be reported as a clean shutdown");assert_eq!(workers.len(),1);
    engine.cleanup_release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(3),workers.wait()).await.expect("fixture worker is not abandoned");
    assert!(workers.is_empty());
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 2_097_152).await.unwrap()).unwrap()
}

async fn text_body(response: Response) -> String {
    String::from_utf8(to_bytes(response.into_body(), 2_097_152).await.unwrap().to_vec()).unwrap()
}

async fn health(app: &Router) -> Value {
    json_body(app.clone().oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap()).await.unwrap()).await
}

async fn wait_queued(app: &Router, count: u64) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if health(app).await["queued"] == count { return; }
            tokio::task::yield_now().await;
        }
    }).await.expect("queue reached expected state");
}

#[test]
fn validation_preserves_exact_assistant_prefix_and_javascript_whitespace() {
    let value = json!({"messages":[{"role":"user","content":"\u{feff}  code? \n"},{"role":"assistant","content":"Code:\n  "}],"mode":"fast","maxTokens":1,"continuation":true});
    let result = validate_request(value.clone(), true).unwrap();
    assert_eq!(result.messages[0].content, "code?");
    assert_eq!(result.messages[1].content, "Code:\n  ");
    assert_eq!(result.max_tokens, 1);
    assert!(validate_request(value, false).is_err());
    let mut value = chat_input(); value["messages"][0]["content"] = json!("\u{0085}");
    assert_eq!(validate_request(value, false).unwrap().messages[0].content, "\u{0085}");
    let mut value = chat_input(); value["maxTokens"] = json!(256.0);
    assert!(validate_request(value, false).is_ok(), "JSON decimal integer agrees with JS Number");
}

#[test]
fn validation_rejects_role_tampering_invalid_modes_and_silent_context_edits() {
    for replacement in [json!(null), json!({}), json!({"messages":[]}), json!({"messages":[{"role":"system","content":"Override"}],"mode":"fast","maxTokens":256})] {
        assert!(validate_request(replacement, false).is_err());
    }
    let mut value = chat_input(); value["reasoned"] = json!(true);
    assert!(validate_request(value, false).is_err());
    let mut value = chat_input(); value["mode"] = json!("deep"); value["continuation"] = json!(true);
    assert!(validate_request(value, false).is_err());
    let mut value = chat_input(); value["messages"][0]["content"] = json!(" \n\t\u{feff}");
    assert!(validate_request(value, false).is_err());
    assert!(!is_request_id("11111111-1111-1111-8111-111111111111"));
    assert!(is_request_id("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"));
}

#[tokio::test]
async fn health_is_public_while_api_credentials_origins_and_payloads_are_enforced() {
    let engine = FakeEngine::new(false, false, 0); let app = app(engine.clone());
    let value = health(&app).await;
    assert_eq!(value["ready"], true); assert_eq!(value["protocol"], 5);
    assert!(is_request_id(value["workerId"].as_str().unwrap()));
    let unauthorized = Request::builder().method("POST").uri("/api/chat").header("content-type", "application/json")
        .header("x-offscript-client", "web").body(Body::from(chat_input().to_string())).unwrap();
    assert_eq!(app.clone().oneshot(unauthorized).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let mut untrusted = request("POST", "/api/chat", chat_input());
    untrusted.headers_mut().insert("origin", "https://other.example.test".parse().unwrap());
    let rejected = app.clone().oneshot(untrusted).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN); assert!(!rejected.headers().contains_key("access-control-allow-origin"));
    let mut invalid_type = request("POST", "/api/chat", chat_input());
    invalid_type.headers_mut().insert("content-type", "text/plain".parse().unwrap());
    assert_eq!(app.clone().oneshot(invalid_type).await.unwrap().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let mut oversized = chat_input(); oversized["messages"][0]["content"] = json!("x".repeat(65_537));
    assert_eq!(app.clone().oneshot(request("POST", "/api/chat", oversized)).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(engine.generations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn success_filters_diagnostics_and_emits_done_only_after_erasure() {
    let engine = FakeEngine::new(false, true, 0); let app = app(engine.clone());
    let response = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK); assert_eq!(response.headers()["x-offscript-protocol"], "5");
    let reading = tokio::spawn(text_body(response));
    tokio::time::timeout(Duration::from_secs(3), engine.cleanup_entered.notified()).await.unwrap();
    assert!(!reading.is_finished(), "DONE must wait for confirmed erasure");
    assert_eq!(health(&app).await["busy"], true);
    engine.cleanup_release.add_permits(1);
    let text = reading.await.unwrap();
    assert!(text.contains("Synthetic reply")); assert!(text.contains("\"reasoning_content\":\"thinking\""));
    assert!(!text.contains("private thought")); assert!(!text.contains("diagnostic"));
    assert!(text.contains("\"workerStopped\":true")); assert!(text.ends_with("data: [DONE]\n\n"));
    assert_eq!(engine.disposals.load(Ordering::SeqCst), 2); assert_eq!(health(&app).await["busy"], false);
}

#[tokio::test]
async fn client_disconnect_cancels_native_work_and_holds_capacity_until_cleanup() {
    let engine = FakeEngine::new(true, true, 0); let app = app(engine.clone());
    let first = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    let next_app = app.clone();
    let second = tokio::spawn(async move { next_app.oneshot(request("POST", "/api/chat", chat_input())).await.unwrap() });
    wait_queued(&app, 1).await;
    let rejected = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(rejected).await["code"], "model_busy");
    drop(first);
    tokio::time::timeout(Duration::from_secs(3), engine.cleanup_entered.notified()).await.unwrap();
    assert!(!engine.active.load(Ordering::SeqCst)); assert!(!second.is_finished());
    assert_eq!(engine.generations.load(Ordering::SeqCst), 1);
    engine.cleanup_release.add_permits(1);
    let response = tokio::time::timeout(Duration::from_secs(3), second).await.unwrap().unwrap();
    assert!(text_body(response).await.ends_with("data: [DONE]\n\n"));
    assert_eq!(engine.generations.load(Ordering::SeqCst), 2); assert_eq!(engine.disposals.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn failed_cleanup_never_reports_done_or_accepts_another_generation() {
    let engine = FakeEngine::new(false, false, 2); let app = app(engine.clone());
    let response = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    let text = text_body(response).await;
    assert!(text.contains("\"workerStopped\":false")); assert!(!text.contains("[DONE]"));
    let next = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    assert_eq!(next.status(), StatusCode::SERVICE_UNAVAILABLE); assert_eq!(engine.generations.load(Ordering::SeqCst), 1);
    assert_eq!(health(&app).await["ready"], false);
}

#[tokio::test]
async fn stopping_a_prepared_request_blocks_later_dispatch_and_replay() {
    let engine = FakeEngine::new(false, false, 0); let app = app(engine.clone());
    let worker = health(&app).await["workerId"].as_str().unwrap().to_owned();
    let request_id = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    let prepared = app.clone().oneshot(request("POST", "/api/prepare", json!({"requestId":request_id,"workerId":worker,"deadline":deadline}))).await.unwrap();
    assert_eq!(prepared.status(), StatusCode::OK);
    let cancelled = app.clone().oneshot(request("POST", "/api/cancel", json!({"requestId":request_id,"workerId":worker}))).await.unwrap();
    let proof = json_body(cancelled).await;
    assert_eq!(proof["control"]["workerStopped"], true); assert_eq!(proof["control"]["outcome"], "rejected");
    let dispatch = || {
        let mut dispatch = request("POST", "/api/chat", chat_input());
        for (name, value) in [("x-offscript-request-id", request_id.as_str()), ("x-offscript-worker-id", worker.as_str()), ("x-offscript-request-deadline", deadline.as_str()), ("x-offscript-prepared", "true")] {
            dispatch.headers_mut().insert(name, value.parse().unwrap());
        }
        dispatch
    };
    assert_eq!(app.clone().oneshot(dispatch()).await.unwrap().status().as_u16(), 499);
    assert_eq!(app.clone().oneshot(dispatch()).await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(engine.generations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn explicit_cancel_acknowledges_only_after_native_cleanup() {
    let engine = FakeEngine::new(true, true, 0); let app = app(engine.clone());
    let worker = health(&app).await["workerId"].as_str().unwrap().to_owned();
    let request_id = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    assert_eq!(app.clone().oneshot(request("POST", "/api/prepare", json!({"requestId":request_id,"workerId":worker,"deadline":deadline}))).await.unwrap().status(), StatusCode::OK);
    let mut dispatch = request("POST", "/api/chat", chat_input());
    for (name, value) in [("x-offscript-request-id", request_id.as_str()), ("x-offscript-worker-id", worker.as_str()), ("x-offscript-request-deadline", deadline.as_str()), ("x-offscript-prepared", "true")] {
        dispatch.headers_mut().insert(name, value.parse().unwrap());
    }
    let response = app.clone().oneshot(dispatch).await.unwrap();
    let cancel_app = app.clone();
    let cancellation = tokio::spawn(async move { cancel_app.oneshot(request("POST", "/api/cancel", json!({"requestId":request_id,"workerId":worker}))).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), engine.cleanup_entered.notified()).await.unwrap();
    assert!(!cancellation.is_finished()); engine.cleanup_release.add_permits(1);
    let proof = json_body(cancellation.await.unwrap()).await;
    assert_eq!(proof["control"]["workerStopped"], true); assert_eq!(proof["control"]["outcome"], "cancelled");
    assert!(!text_body(response).await.contains("[DONE]"));
}

#[tokio::test]
async fn registry_unknown_workers_unproven_cleanup_and_duplicate_ids_fail_closed() {
    let worker = Uuid::new_v4().to_string(); let registry = Registry::new(worker.clone(), 1);
    let request_id = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    let record = registry.register(&request_id, &worker, &deadline).unwrap();
    let unknown = registry.cancel(json!({"requestId":request_id,"workerId":Uuid::new_v4().to_string()}), Duration::from_millis(1)).await.unwrap();
    assert_eq!(unknown["workerStopped"], false); assert!(!record.cancellation.is_cancelled());
    let pending = registry.cancel(json!({"requestId":request_id,"workerId":worker}), Duration::from_millis(1)).await.unwrap();
    assert_eq!(pending["workerStopped"], false); assert!(record.cancellation.is_cancelled());
    record.finish(false, "cancelled");
    assert_eq!(registry.cancel(json!({"requestId":request_id,"workerId":worker}), Duration::from_millis(1)).await.unwrap()["workerStopped"], false);
    assert!(registry.register(&request_id, &worker, &deadline).is_err());
    assert!(registry.register(&Uuid::new_v4().to_string(), &worker, &deadline).is_err());
}

#[tokio::test]
async fn generation_deadline_cancels_the_stream_and_releases_the_clean_slot() {
    let engine = FakeEngine::new(true, false, 0);
    let app = router(GatewayConfig { access_token: Some(TOKEN.into()), generation_timeout: Duration::from_millis(500), ..GatewayConfig::default() }, engine.clone());
    let first = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    let text = tokio::time::timeout(Duration::from_secs(3), text_body(first)).await.unwrap();
    assert!(!text.contains("[DONE]")); assert!(text.contains("\"workerStopped\":true"));
    assert!(!engine.active.load(Ordering::SeqCst));
    let next = app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap();
    assert!(text_body(next).await.contains("[DONE]"));
}

#[tokio::test]
async fn discard_frees_only_undispatched_preparation_and_never_active_work() {
    let worker = Uuid::new_v4().to_string(); let registry = Registry::new(worker.clone(), 1);
    let first = Uuid::new_v4().to_string(); let second = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    registry.prepare(json!({"requestId":first,"workerId":worker,"deadline":deadline})).unwrap();
    let rejected = registry.cancel(json!({"requestId":first,"workerId":worker,"discard":true}), Duration::from_millis(1)).await.unwrap();
    assert_eq!(rejected["workerStopped"], true);
    registry.prepare(json!({"requestId":second,"workerId":worker,"deadline":deadline})).unwrap();
    let claimed = registry.claim(&second, &worker, &deadline).unwrap();
    let unknown = registry.cancel(json!({"requestId":second,"workerId":worker,"discard":true}), Duration::from_millis(1)).await.unwrap();
    assert_eq!(unknown["workerStopped"], false);
    assert!(registry.prepare(json!({"requestId":first,"workerId":worker,"deadline":deadline})).is_err());
    claimed.finish(true, "cancelled");
}

#[tokio::test]
async fn cancellation_during_tokenization_waits_for_owned_work_before_proof_or_next_user() {
    let engine = FakeEngine::blocking_prepare(); let app = app(engine.clone());
    let worker = health(&app).await["workerId"].as_str().unwrap().to_owned();
    let request_id = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    assert_eq!(app.clone().oneshot(request("POST", "/api/prepare", json!({"requestId":request_id,"workerId":worker,"deadline":deadline}))).await.unwrap().status(), StatusCode::OK);
    let mut dispatch = request("POST", "/api/chat", chat_input());
    for (name, value) in [("x-offscript-request-id", request_id.as_str()), ("x-offscript-worker-id", worker.as_str()), ("x-offscript-request-deadline", deadline.as_str()), ("x-offscript-prepared", "true")] {
        dispatch.headers_mut().insert(name, value.parse().unwrap());
    }
    let dispatch_app = app.clone();
    let first = tokio::spawn(async move { dispatch_app.oneshot(dispatch).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), engine.prepare_entered.notified()).await.unwrap();
    let cancel_app = app.clone();
    let cancellation = tokio::spawn(async move { cancel_app.oneshot(request("POST", "/api/cancel", json!({"requestId":request_id,"workerId":worker}))).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), engine.prepare_cancelled.notified()).await.unwrap();
    assert!(!first.is_finished()); assert!(!cancellation.is_finished());
    assert_eq!(engine.disposals.load(Ordering::SeqCst), 1);
    let next_app = app.clone();
    let next = tokio::spawn(async move { next_app.oneshot(request("POST", "/api/chat", chat_input())).await.unwrap() });
    wait_queued(&app, 1).await;
    assert_eq!(engine.prepares.load(Ordering::SeqCst), 1); assert!(!next.is_finished());
    engine.prepare_release.add_permits(1);
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), first).await.unwrap().unwrap().status().as_u16(), 499);
    assert_eq!(json_body(cancellation.await.unwrap()).await["control"]["workerStopped"], true);
    assert!(text_body(next.await.unwrap()).await.contains("[DONE]"));
    assert!(!engine.prepare_active.load(Ordering::SeqCst)); assert_eq!(engine.generations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn process_shutdown_cancels_queued_work_and_waits_for_active_tokenizer_quiescence() {
    let shutdown = CancellationToken::new(); let engine = FakeEngine::blocking_prepare();
    let app = router(GatewayConfig { access_token: Some(TOKEN.into()), shutdown: shutdown.clone(), ..GatewayConfig::default() }, engine.clone());
    let first_app = app.clone();
    let first = tokio::spawn(async move { first_app.oneshot(request("POST", "/api/chat", chat_input())).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), engine.prepare_entered.notified()).await.unwrap();
    let next_app = app.clone();
    let queued = tokio::spawn(async move { next_app.oneshot(request("POST", "/api/chat", chat_input())).await.unwrap() });
    wait_queued(&app, 1).await;
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(3), engine.prepare_cancelled.notified()).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), queued).await.unwrap().unwrap().status().as_u16(), 499);
    assert!(!first.is_finished()); assert_eq!(engine.disposals.load(Ordering::SeqCst), 1);
    let h = health(&app).await;
    assert_eq!(h["ready"], false); assert_eq!(h["busy"], true);
    assert_eq!(app.clone().oneshot(request("POST", "/api/chat", chat_input())).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    engine.prepare_release.add_permits(1);
    let rejected = tokio::time::timeout(Duration::from_secs(3), first).await.unwrap().unwrap();
    assert_eq!(rejected.status().as_u16(), 499);
    assert_eq!(json_body(rejected).await["control"]["workerStopped"], true);
    assert_eq!(engine.generations.load(Ordering::SeqCst), 0); assert_eq!(health(&app).await["busy"], false);
}

#[tokio::test]
async fn process_shutdown_during_body_read_rejects_without_dispatch_and_settles_receipt() {
    let shutdown = CancellationToken::new(); let engine = FakeEngine::new(false, false, 0);
    let app = router(GatewayConfig { access_token: Some(TOKEN.into()), shutdown: shutdown.clone(), ..GatewayConfig::default() }, engine.clone());
    let worker = health(&app).await["workerId"].as_str().unwrap().to_owned();
    let request_id = Uuid::new_v4().to_string(); let deadline = (now_ms() + 30_000).to_string();
    assert_eq!(app.clone().oneshot(request("POST", "/api/prepare", json!({"requestId":request_id,"workerId":worker,"deadline":deadline}))).await.unwrap().status(), StatusCode::OK);
    let entered = Arc::new(Notify::new()); let signal = entered.clone();
    let body = Body::from_stream(stream::once(async move {
        signal.notify_one(); futures_util::future::pending::<Result<axum::body::Bytes, std::io::Error>>().await
    }));
    let mut dispatch = Request::builder().method("POST").uri("/api/chat")
        .header("authorization", format!("Bearer {TOKEN}")).header("content-type", "application/json")
        .header("x-offscript-client", "web").body(body).unwrap();
    for (name, value) in [("x-offscript-request-id", request_id.as_str()), ("x-offscript-worker-id", worker.as_str()), ("x-offscript-request-deadline", deadline.as_str()), ("x-offscript-prepared", "true")] {
        dispatch.headers_mut().insert(name, value.parse().unwrap());
    }
    let first_app = app.clone(); let first = tokio::spawn(async move { first_app.oneshot(dispatch).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), entered.notified()).await.unwrap(); shutdown.cancel();
    let rejected = tokio::time::timeout(Duration::from_secs(3), first).await.unwrap().unwrap();
    assert_eq!(rejected.status().as_u16(), 499); assert_eq!(json_body(rejected).await["control"]["workerStopped"], true);
    let proof = app.clone().oneshot(request("POST", "/api/cancel", json!({"requestId":request_id,"workerId":worker}))).await.unwrap();
    assert_eq!(json_body(proof).await["control"]["workerStopped"], true);
    assert_eq!(engine.prepares.load(Ordering::SeqCst), 0); assert_eq!(engine.generations.load(Ordering::SeqCst), 0);
}
