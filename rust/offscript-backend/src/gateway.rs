use std::{io, pin::Pin, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, task::{Context, Poll}, time::Duration};

use axum::{body::{to_bytes, Body, Bytes}, extract::{Request, State}, http::{header, HeaderMap, HeaderValue, Method, StatusCode}, response::Response, Router};
use futures_util::{FutureExt, Stream, StreamExt};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::{sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore}, task::JoinHandle};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{config::GatewayConfig, engine::{Engine, ModelEvent}, registry::{now_ms, Record, Registry}, request::{validate_request, ChatInput}, BackendError};

const MAX_BODY: usize = 65_536;
const MAX_STREAM_BYTES: usize = 2_097_152;

struct App {
    config: GatewayConfig,
    engine: Arc<dyn Engine>,
    registry: Registry,
    slot: Arc<Semaphore>,
    queued: Mutex<usize>,
    busy: AtomicBool,
    healthy: AtomicBool,
}

/// Private Samsung API only; Vercel continues to serve the public website and
/// verify account sessions. This process never receives account JWTs or chats
/// for durable storage.
pub fn router(config: GatewayConfig, engine: Arc<dyn Engine>) -> Router {
    let registry = Registry::with_shutdown(Uuid::new_v4().to_string(), 1024, config.shutdown.clone());
    let app = Arc::new(App { config, engine, registry, slot: Arc::new(Semaphore::new(1)),
        queued: Mutex::new(0), busy: AtomicBool::new(false), healthy: AtomicBool::new(true) });
    Router::new().fallback(handle).with_state(app)
}

fn json_response(status: u16, value: Value, chat: bool) -> Response {
    let mut response = Response::new(Body::from(serde_json::to_vec(&value).expect("JSON response")));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if chat { response.headers_mut().insert("x-offscript-protocol", HeaderValue::from_static("5")); }
    response
}

fn control(record: Option<&Record>, stopped: bool, outcome: &str) -> Value {
    match record {
        Some(record) => json!({"requestId":record.request_id,"workerId":record.worker_id,"workerStopped":stopped,"outcome":outcome}),
        None => json!({"workerStopped":stopped,"outcome":outcome}),
    }
}

fn error_response(error: BackendError, record: Option<&Record>, stopped: bool, started: bool, chat: bool) -> Response {
    let mut value = json!({"error":error.message});
    if chat { value["control"] = control(record, stopped, if started { "failed" } else { "rejected" }); }
    if let Some(code) = error.code { value["code"] = json!(code); }
    json_response(error.status, value, chat)
}

async fn body_json(request: Request) -> Result<Value, BackendError> {
    if request.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next()).map(|value| value.trim().eq_ignore_ascii_case("application/json")) != Some(true) {
        return Err(BackendError::new(415, "Send JSON."));
    }
    let bytes = tokio::time::timeout(Duration::from_secs(15), to_bytes(request.into_body(), MAX_BODY)).await
        .map_err(|_| BackendError::new(408, "Request timed out."))?
        .map_err(|_| BackendError::new(413, "This message is too large. Please shorten it."))?;
    serde_json::from_slice(&bytes).map_err(|_| BackendError::new(400, "Invalid message data."))
}

fn authenticated(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let actual = headers.get(header::AUTHORIZATION).map(HeaderValue::as_bytes).unwrap_or_default();
    actual.len() == expected.len() && bool::from(actual.ct_eq(expected.as_bytes()))
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let is_chat = path == "/api/chat";
    let origin = request.headers().get(header::ORIGIN).cloned();
    let origin_allowed = origin.as_ref().and_then(|value| value.to_str().ok()).is_some_and(|value| app.config.origins.contains(value));
    let response = if origin.is_some() {
        if !origin_allowed {
            Some(error_response(BackendError::new(403, "This website is not allowed to use this server."), None, true, false, is_chat))
        } else { None }
    } else { None };
    let mut response = match response {
        Some(response) => response,
        None => route(app, request, &path).await,
    };
    response.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    if let Some(value) = origin {
        // A rejected origin must never receive an allow-origin reflection.
        if origin_allowed {
            response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            response.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
    response
}

async fn route(app: Arc<App>, request: Request, path: &str) -> Response {
    if request.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type, X-Offscript-Client"));
        response.headers_mut().insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        return response;
    }
    let is_chat = path == "/api/chat";
    if path.starts_with("/api/") && path != "/api/health" {
        if let Some(ref token) = app.config.access_token {
            if !authenticated(request.headers(), token) {
                return error_response(BackendError::new(401, "Service authentication is required."), None, true, false, is_chat);
            }
        }
    }
    if path == "/api/health" && request.method() == Method::GET {
        let ready = !app.config.shutdown.is_cancelled() && app.healthy.load(Ordering::Acquire) && app.engine.ready().await;
        let queued = *app.queued.lock().expect("queue count lock");
        return json_response(if ready { 200 } else { 503 }, json!({"ready":ready,"queued":queued,
            "busy":app.busy.load(Ordering::Acquire),"protocol":5,"workerId":app.registry.worker_id,"modes":["fast","deep"]}), false);
    }
    if ["/api/prepare", "/api/cancel"].contains(&path) && request.method() == Method::POST {
        if app.config.access_token.is_none() {
            return error_response(BackendError::new(503, "Service authentication is required."), None, true, false, false);
        }
        let result = match body_json(request).await {
            Ok(value) if path == "/api/prepare" => app.registry.prepare(value),
            Ok(value) => app.registry.cancel(value, Duration::from_secs(20)).await.map(|value| json!({"control":value})),
            Err(error) => Err(error),
        };
        return match result { Ok(value) => json_response(200, value, false), Err(error) => error_response(error, None, true, false, false) };
    }
    if is_chat && request.method() == Method::POST {
        return chat(app, request).await;
    }
    error_response(BackendError::new(404, if path.starts_with("/api/") { "API route not found." } else { "Not found." }), None, true, false, false)
}

struct CancelOnDrop {
    cancellation: CancellationToken,
    armed: bool,
    undispatched: Option<Arc<Record>>,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
            if let Some(ref record) = self.undispatched { record.finish(true, "rejected"); }
        }
    }
}

struct ClientStream {
    receiver: ReceiverStream<Result<Bytes, io::Error>>,
    cancellation: CancellationToken,
}
impl Stream for ClientStream {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.receiver).poll_next(context)
    }
}
impl Drop for ClientStream {
    fn drop(&mut self) { self.cancellation.cancel(); }
}

struct TaskGuard(JoinHandle<()>);
impl Drop for TaskGuard {
    fn drop(&mut self) { self.0.abort(); }
}

async fn chat(app: Arc<App>, request: Request) -> Response {
    if app.config.shutdown.is_cancelled() {
        return error_response(BackendError::new(503, "The gateway is shutting down."), None, true, false, true);
    }
    if request.headers().get("x-offscript-client").and_then(|value| value.to_str().ok()) != Some("web") {
        return error_response(BackendError::new(403, "Invalid client."), None, true, false, true);
    }
    let receipt = match receipt(&app.registry, request.headers(), app.config.access_token.is_some()) {
        Ok(value) => value,
        Err(error) => return error_response(error, None, true, false, true),
    };
    let cancellation = receipt.as_ref().map(|record| record.cancellation.clone()).unwrap_or_else(|| app.config.shutdown.child_token());
    let mut client_guard = CancelOnDrop { cancellation: cancellation.clone(), armed: true, undispatched: receipt.clone() };
    let deadline = receipt.as_ref().map(|record| {
        let token = cancellation.clone();
        let delay = Duration::from_millis(record.expires_at.saturating_sub(now_ms()));
        TaskGuard(tokio::spawn(async move { tokio::time::sleep(delay).await; token.cancel(); }))
    });
    let input_result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled()),
        result = body_json(request) => result.and_then(|value| validate_request(value, receipt.is_some())),
    };
    let input = match input_result {
        Ok(value) => value,
        Err(error) => {
            if let Some(ref record) = receipt { record.finish(true, "rejected"); }
            return error_response(error, receipt.as_deref(), true, false, true);
        }
    };
    let (response_tx, response_rx) = oneshot::channel();
    let worker_token = cancellation.clone();
    client_guard.undispatched = None;
    // The worker owns the slot through cleanup, independently of a browser
    // disconnect. A dropped HTTP future or body cancels it, never abandons it.
    // Track the full cleanup lifecycle, including after the HTTP connection has
    // disappeared. Process shutdown must not mistake "no sockets" for "erased".
    let workers = app.config.workers.clone();
    workers.spawn(async move { worker(app, input, receipt, worker_token, deadline, response_tx).await; });
    let response = response_rx.await.unwrap_or_else(|_| error_response(BackendError::new(503, "The model connection failed. Please try again."), None, false, false, true));
    // Streaming bodies now own cancellation. Non-streaming workers have already
    // completed cleanup before returning this response.
    client_guard.armed = false;
    response
}

fn receipt(registry: &Registry, headers: &HeaderMap, service_auth: bool) -> Result<Option<Arc<Record>>, BackendError> {
    let Some(request_id) = headers.get("x-offscript-request-id") else { return Ok(None); };
    if !service_auth { return Err(BackendError::new(503, "Service authentication is required.")); }
    let invalid = || BackendError::new(400, "Invalid request receipt.");
    let request_id = request_id.to_str().map_err(|_| invalid())?;
    let worker_id = headers.get("x-offscript-worker-id").and_then(|value| value.to_str().ok()).ok_or_else(invalid)?;
    let deadline = headers.get("x-offscript-request-deadline").and_then(|value| value.to_str().ok()).ok_or_else(invalid)?;
    let prepared = headers.get("x-offscript-prepared");
    if prepared.is_some_and(|value| value.as_bytes() != b"true") { return Err(BackendError::new(400, "Invalid prepared request.")); }
    if prepared.is_some() { registry.claim(request_id, worker_id, deadline).map(Some) }
    else { registry.register(request_id, worker_id, deadline).map(Some) }
}

struct QueueGuard(Arc<App>);
impl Drop for QueueGuard {
    fn drop(&mut self) { *self.0.queued.lock().expect("queue count lock") -= 1; }
}

async fn acquire(app: &Arc<App>, cancellation: &CancellationToken, continuation: bool) -> Result<OwnedSemaphorePermit, BackendError> {
    if cancellation.is_cancelled() { return Err(cancelled()); }
    if let Ok(permit) = app.slot.clone().try_acquire_owned() {
        app.busy.store(true, Ordering::Release);
        return Ok(permit);
    }
    {
        let mut queued = app.queued.lock().expect("queue count lock");
        if *queued >= if continuation { 32 } else { app.config.queue_limit } { return Err(BackendError::busy()); }
        *queued += 1;
    }
    let _waiting = QueueGuard(app.clone());
    let wait = if continuation { Duration::from_secs(300) } else { app.config.queue_timeout };
    let permit = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled()),
        result = tokio::time::timeout(wait, app.slot.clone().acquire_owned()) => match result {
            Ok(Ok(permit)) => permit,
            _ => return Err(BackendError::busy()),
        },
    };
    app.busy.store(true, Ordering::Release);
    Ok(permit)
}

fn cancelled() -> BackendError { BackendError::new(499, "Request cancelled.") }

async fn check_thermal(app: &App) -> bool {
    let Some(ref root) = app.config.thermal_root else { return false; };
    let Ok(mut directories) = tokio::fs::read_dir(root).await else { return false; };
    while let Ok(Some(directory)) = directories.next_entry().await {
        let Ok(name) = tokio::fs::read_to_string(directory.path().join("name")).await else { continue; };
        if !name.contains("coretemp") && !name.contains("acpitz") { continue; }
        let Ok(mut entries) = tokio::fs::read_dir(directory.path()).await else { continue; };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name(); let name = name.to_string_lossy();
            if name.len() > 10 && name.starts_with("temp") && name.ends_with("_input") && name[4..name.len()-6].chars().all(|value| value.is_ascii_digit()) {
                if let Ok(value) = tokio::fs::read_to_string(entry.path()).await {
                    if value.trim().parse::<i64>().is_ok_and(|value| value >= 85_000) { return true; }
                }
            }
        }
    }
    false
}

async fn emit(sender: &mpsc::Sender<Result<Bytes, io::Error>>, value: &Value, cancellation: &CancellationToken) -> Result<(), BackendError> {
    let bytes = Bytes::from(format!("data: {}\n\n", serde_json::to_string(value).expect("JSON event")));
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled()),
        result = sender.send(Ok(bytes)) => result.map_err(|_| cancelled()),
    }
}

async fn worker(app: Arc<App>, input: ChatInput, record: Option<Arc<Record>>, cancellation: CancellationToken,
    _deadline: Option<TaskGuard>, response_tx: oneshot::Sender<Response>) {
    let mut response_tx = Some(response_tx);
    let mut sender = None;
    let mut permit = None;
    let mut started = false;
    let mut worker_stopped = true;
    let mut requires_cleanup = false;
    let mut generation_timer = None;
    let mut thermal_timer = None;
    let native_cancellation = cancellation.child_token();
    let mut result: Result<(), BackendError> = std::panic::AssertUnwindSafe(async {
        permit = Some(acquire(&app, &cancellation, input.continuation).await?);
        if !app.healthy.load(Ordering::Acquire) { return Err(BackendError::new(503, "The model needs to restart before another request.")); }
        worker_stopped = false;
        if !app.engine.dispose().await {
            app.healthy.store(false, Ordering::Release);
            return Err(BackendError::new(503, "The model server is not ready. Please try again later."));
        }
        worker_stopped = true;
        requires_cleanup = true;
        if check_thermal(&app).await { return Err(BackendError::new(503, "The laptop is cooling down. Try again in a moment.")); }
        let token = cancellation.clone(); let timeout = app.config.generation_timeout;
        generation_timer = Some(TaskGuard(tokio::spawn(async move { tokio::time::sleep(timeout).await; token.cancel(); })));
        if app.config.thermal_root.is_some() {
            let app = app.clone(); let token = cancellation.clone();
            thermal_timer = Some(TaskGuard(tokio::spawn(async move {
                loop {
                    tokio::select! { _ = token.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                    if check_thermal(&app).await { token.cancel(); break; }
                }
            })));
        }
        // prepare owns bounded CPU tokenization. It observes cancellation but
        // must await that work's quiescence rather than detach an owned prompt.
        let prepared = app.engine.prepare(&input, &native_cancellation).await?;
        if cancellation.is_cancelled() { return Err(cancelled()); }
        started = true; worker_stopped = false;
        let mut stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled()),
            result = app.engine.generate(prepared, native_cancellation.clone()) => result?,
        };
        let (event_tx, event_rx) = mpsc::channel(1);
        let body = Body::from_stream(ClientStream { receiver: ReceiverStream::new(event_rx), cancellation: cancellation.clone() });
        let mut response = Response::new(body);
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store, no-transform"));
        response.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
        response.headers_mut().insert("x-offscript-protocol", HeaderValue::from_static("5"));
        if response_tx.take().expect("one response").send(response).is_err() { return Err(cancelled()); }
        sender = Some(event_tx);
        let mut bytes = 0usize;
        loop {
            let next = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled()),
                value = stream.next() => value,
            };
            match next {
                Some(Ok(ModelEvent::Done)) => return Ok(()),
                Some(Ok(ModelEvent::Data(event))) => {
                    bytes = bytes.saturating_add(serde_json::to_vec(&event).map_err(|_| BackendError::new(502, "The model sent an invalid response."))?.len());
                    if bytes > MAX_STREAM_BYTES { return Err(BackendError::new(502, "The model sent an invalid response.")); }
                    if event.get("error").is_some() { return Err(BackendError::new(502, "The model stopped unexpectedly.")); }
                    if let Some(choice) = event.get("choices").and_then(Value::as_array).and_then(|items| items.first()) {
                        let mut delta = json!({});
                        if let Some(content) = choice.get("delta").and_then(|value| value.get("content")).and_then(Value::as_str) { delta["content"] = json!(content); }
                        if choice.get("delta").and_then(|value| value.get("reasoning_content")).is_some_and(json_truthy) { delta["reasoning_content"] = json!("thinking"); }
                        let mut filtered = json!({"choices":[{"delta":delta,"finish_reason":choice.get("finish_reason").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)}]});
                        if let Some(usage) = event.get("usage") { filtered["usage"] = usage.clone(); }
                        emit(sender.as_ref().expect("stream sender"), &filtered, &cancellation).await?;
                    } else if let Some(usage) = event.get("usage") {
                        emit(sender.as_ref().expect("stream sender"), &json!({"usage":usage}), &cancellation).await?;
                    }
                }
                Some(Err(error)) => return Err(error),
                None => return Err(BackendError::new(502, "The model stream ended before completion. Please try again.")),
            }
        }
    }).catch_unwind().await.unwrap_or_else(|_| {
        app.healthy.store(false, Ordering::Release);
        requires_cleanup |= permit.is_some();
        Err(BackendError::new(503, "The model needs to restart before another request."))
    });

    // Dropping the native stream and cancelling its token precedes erasure.
    // Erasure is independent of the disconnected client's cancellation token.
    native_cancellation.cancel();
    drop(generation_timer); drop(thermal_timer);
    if requires_cleanup {
        worker_stopped = app.engine.dispose().await;
        if !worker_stopped {
            app.healthy.store(false, Ordering::Release);
            result = Err(BackendError::new(503, "The model needs to restart before another request."));
        }
    }
    if result.is_ok() && cancellation.is_cancelled() { result = Err(cancelled()); }
    let outcome = if result.is_ok() { "completed" } else if started { "cancelled" } else { "rejected" };
    if let Some(ref record) = record { record.finish(worker_stopped, outcome); }
    if permit.is_some() { app.busy.store(false, Ordering::Release); }
    drop(permit);
    if let Some(sender) = sender {
        let value = match result {
            Ok(()) => format!("data: {}\n\ndata: [DONE]\n\n", json!({"control":control(record.as_deref(),worker_stopped,"completed")})),
            Err(error) => format!("data: {}\n\n", json!({"error":error.message,"control":control(record.as_deref(),worker_stopped,if started {"failed"} else {"rejected"})})),
        };
        // Capacity is already safely released. A slow client cannot hold the
        // model slot just by refusing the final content-free receipt.
        let _ = tokio::time::timeout(Duration::from_secs(5), sender.send(Ok(Bytes::from(value)))).await;
    } else if let Some(response_tx) = response_tx {
        let error = result.err().unwrap_or_else(|| BackendError::new(503, "The model connection failed. Please try again."));
        let _ = response_tx.send(error_response(error, record.as_deref(), worker_stopped, started, true));
    }
}

fn json_truthy(value: &Value) -> bool {
    match value { Value::Null => false, Value::Bool(value) => *value, Value::String(value) => !value.is_empty(), Value::Number(value) => value.as_f64() != Some(0.0), _ => true }
}
