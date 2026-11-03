use async_trait::async_trait;
use axum::{body::{to_bytes, Body}, extract::State, http::{Request, Response, StatusCode}, response::IntoResponse, Json, Router};
use futures_util::StreamExt;
use offscript_backend::{engine::{Engine, LlamaEngine, ModelEvent}, request::{ChatInput, Message, Mode}, tokenizer::Tokenizer, BackendError};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}}};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[derive(Clone)]
struct Chunk {
    content: Value,
    finish: &'static str,
    tokens: usize,
    no_done: bool,
    reasoning: bool,
}
impl Chunk {
    fn text(text: &str, finish: &'static str, tokens: usize) -> Self {
        Self { content: json!(text), finish, tokens, no_done: false, reasoning: false }
    }
}

#[derive(Default)]
struct RustTokenizer {
    count: AtomicUsize,
    calls: Mutex<Vec<String>>,
    hold_continuation: AtomicBool,
    owns_text: AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
#[async_trait]
impl Tokenizer for RustTokenizer {
    async fn ready(&self) -> bool { true }
    async fn encode(&self, prompt: &str, cancel: &CancellationToken) -> Result<Vec<u32>, BackendError> {
        if cancel.is_cancelled() { return Err(BackendError::new(499, "Request cancelled.")); }
        let call = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(prompt.to_owned());
            calls.len()
        };
        if call > 1 && self.hold_continuation.load(Ordering::SeqCst) {
            // Model an owned, non-abortable CPU job. Cancelling the receiver
            // must not let erasure acknowledge before this work returns.
            self.owns_text.store(true, Ordering::SeqCst);
            self.entered.notify_one();
            self.release.notified().await;
            self.owns_text.store(false, Ordering::SeqCst);
            if cancel.is_cancelled() { return Err(BackendError::new(499, "Request cancelled.")); }
        }
        Ok(vec![123; self.count.load(Ordering::SeqCst)])
    }
}

struct Native {
    calls: Mutex<Vec<(String, Value)>>,
    chunks: Mutex<VecDeque<Chunk>>,
    generation: AtomicUsize,
    template: AtomicUsize,
    capability: AtomicBool,
    cleanup_capability: AtomicBool,
    mismatched_continuation: AtomicBool,
    erase_failures: AtomicUsize,
    erase_calls: AtomicUsize,
    erase_reply: Mutex<Value>,
    remove_erase_proof_after_generation: AtomicBool,
    props_delay_ms: AtomicUsize,
    health_delay_ms: AtomicUsize,
}

fn render(messages: &[Value]) -> String {
    let mut output = String::new();
    for (index, message) in messages.iter().enumerate() {
        let content = message["content"].as_str().unwrap();
        if message["role"] == "user" { output.push_str(&format!("U:{content}\nA:")); }
        else { output.push_str(content); if index + 1 < messages.len() { output.push_str("\nEND\n"); } }
    }
    output
}

async fn native(State(state): State<Arc<Native>>, request: Request<Body>) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let body = to_bytes(request.into_body(), 262144).await.unwrap();
    let body: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap() };
    state.calls.lock().unwrap().push((path.clone(), body.clone()));
    let delay = match path.as_str() {
        "/props" => state.props_delay_ms.load(Ordering::SeqCst),
        "/health" => state.health_delay_ms.load(Ordering::SeqCst),
        _ => 0,
    };
    if delay != 0 { tokio::time::sleep(std::time::Duration::from_millis(delay as u64)).await; }
    match path.as_str() {
        "/health" => Json(json!({"status":"ok"})).into_response(),
        "/props" => {
            let mut capabilities = json!({});
            if state.capability.load(Ordering::SeqCst) { capabilities["offscript_input_tokens_version"] = json!(1); }
            if state.cleanup_capability.load(Ordering::SeqCst) { capabilities["offscript_erase_state_version"] = json!(1); }
            Json(capabilities).into_response()
        }
        "/slots/0" => {
            let call = state.erase_calls.fetch_add(1, Ordering::SeqCst);
            if call < state.erase_failures.load(Ordering::SeqCst) { StatusCode::SERVICE_UNAVAILABLE.into_response() }
            else { Json(state.erase_reply.lock().unwrap().clone()).into_response() }
        }
        "/apply-template" => {
            let mut prompt = render(body["messages"].as_array().unwrap());
            if state.template.fetch_add(1, Ordering::SeqCst) > 0 && state.mismatched_continuation.load(Ordering::SeqCst) { prompt.push_str("changed"); }
            Json(json!({"prompt":prompt})).into_response()
        }
        "/v1/chat/completions" => {
            if body["offscript_rendered_prompt"].as_str() != Some(render(body["messages"].as_array().unwrap()).as_str())
                || !body["offscript_prompt_tokens"].as_array().is_some_and(|tokens|tokens.iter().all(|token|token.as_u64()==Some(123))) {
                return StatusCode::BAD_REQUEST.into_response();
            }
            let index = state.generation.fetch_add(1, Ordering::SeqCst);
            let Some(chunk) = state.chunks.lock().unwrap().pop_front() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
            if state.remove_erase_proof_after_generation.load(Ordering::SeqCst) {
                state.erase_reply.lock().unwrap().as_object_mut().unwrap().remove("offscript_erase_state_version");
            }
            let mut text = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":null}}]}\n\n".to_owned();
            if chunk.reasoning {
                text.push_str(&format!("data: {}\n\n", json!({"choices":[{"delta":{"reasoning_content":"private thought"},"finish_reason":null}]})));
            }
            text.push_str(&format!("data: {}\n\n", json!({"choices":[{"delta":{"content":chunk.content},"finish_reason":chunk.finish}]})));
            text.push_str(&format!("data: {}\n\n", json!({"usage":{"prompt_tokens":if index==0 {10}else{99},"completion_tokens":chunk.tokens}})));
            if !chunk.no_done { text.push_str("data: [DONE]\n\n"); }
            Response::builder().header("content-type", "text/event-stream; charset=utf-8").body(Body::from(text)).unwrap()
        }
        // No candidate operation is permitted to call the C++ tokenizer.
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

struct Fixture {
    engine: Arc<LlamaEngine>,
    state: Arc<Native>,
    tokenizer: Arc<RustTokenizer>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture { fn drop(&mut self) { self.server.abort(); } }
impl Fixture {
    async fn new(chunks: Vec<Chunk>) -> Self {
        let state = Arc::new(Native { calls: Mutex::new(Vec::new()), chunks: Mutex::new(chunks.into()), generation: AtomicUsize::new(0), template: AtomicUsize::new(0), capability: AtomicBool::new(true), cleanup_capability: AtomicBool::new(true), mismatched_continuation: AtomicBool::new(false), erase_failures: AtomicUsize::new(0), erase_calls: AtomicUsize::new(0), erase_reply: Mutex::new(json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":0})), remove_erase_proof_after_generation: AtomicBool::new(false), props_delay_ms: AtomicUsize::new(0), health_delay_ms: AtomicUsize::new(0) });
        let app = Router::new().fallback(native).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let tokenizer = Arc::new(RustTokenizer { count: AtomicUsize::new(10), ..Default::default() });
        let engine = Arc::new(LlamaEngine::with_limits(&origin, tokenizer.clone(), 4096, 2).unwrap());
        Self { engine, state, tokenizer, server }
    }
    fn generations(&self) -> Vec<Value> {
        self.state.calls.lock().unwrap().iter().filter(|(path,_)|path=="/v1/chat/completions").map(|(_,body)|body.clone()).collect()
    }
}

fn input() -> ChatInput {
    ChatInput { messages: vec![Message { role:"user".into(), content:"Code?".into() }], max_tokens:4, mode:Mode::Fast, continuation:false }
}

async fn collect(f: &Fixture, input: ChatInput) -> Result<Vec<ModelEvent>, BackendError> {
    let cancel = CancellationToken::new();
    let prepared = f.engine.prepare(&input, &cancel).await?;
    let mut stream = f.engine.generate(prepared, cancel).await?;
    let mut events = Vec::new();
    while let Some(event) = stream.next().await { events.push(event?); }
    Ok(events)
}

#[tokio::test]
async fn rust_ids_feed_generation_and_continuation_aggregates_unique_usage() {
    let f = Fixture::new(vec![Chunk::text("Code:\n  ", "length", 2), Chunk::text("done", "stop", 1)]).await;
    let events = collect(&f, input()).await.unwrap();
    let requests = f.generations();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["max_tokens"], 2);
    assert_eq!(requests[1]["max_tokens"], 2);
    assert!(requests.iter().all(|request|request["cache_prompt"]==true && request["id_slot"]==0 && request["offscript_prompt_tokens"]==json!(vec![123;10])));
    assert_eq!(requests[1]["messages"][1], json!({"role":"assistant","content":"Code:\n  "}));
    assert_eq!(requests[1]["continue_final_message"], "content");
    assert_eq!(requests[1]["add_generation_prompt"], false);
    assert_eq!(f.tokenizer.calls.lock().unwrap().as_slice(), ["U:Code?\nA:", "U:Code?\nA:Code:\n  "]);
    assert!(!f.state.calls.lock().unwrap().iter().any(|(path,_)|path=="/tokenize"));
    let ModelEvent::Data(final_event) = &events[events.len()-2] else { panic!("Missing final usage"); };
    assert_eq!(final_event["usage"], json!({"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}));
    assert_eq!(final_event["choices"][0]["finish_reason"], "stop");
    assert!(matches!(events.last(), Some(ModelEvent::Done)));
}

#[tokio::test]
async fn exact_unfinished_assistant_prefix_is_preserved() {
    let f = Fixture::new(vec![Chunk::text("x", "length", 2), Chunk::text("y", "length", 1)]).await;
    let mut value = input(); value.max_tokens=3; value.continuation=true;
    value.messages.push(Message { role:"assistant".into(), content:"Prefix  ".into() });
    let events = collect(&f,value).await.unwrap();
    let requests=f.generations();
    assert_eq!(requests[1]["max_tokens"],1);
    assert_eq!(requests[1]["messages"][1]["content"],"Prefix  x");
    let ModelEvent::Data(final_event)=&events[events.len()-2] else {panic!()};
    assert_eq!(final_event["usage"]["completion_tokens"],3);
    assert_eq!(final_event["choices"][0]["finish_reason"],"length");
}

#[tokio::test]
async fn natural_stop_does_not_create_a_second_generation() {
    let f=Fixture::new(vec![Chunk::text("Done.","stop",1)]).await;
    collect(&f,input()).await.unwrap();
    assert_eq!(f.generations().len(),1);
}

#[tokio::test]
async fn deep_mode_preserves_native_reasoning_settings() {
    let mut chunk=Chunk::text("Answer","stop",1);chunk.reasoning=true;
    let f=Fixture::new(vec![chunk]).await;
    let mut value=input();value.mode=Mode::Deep;value.max_tokens=256;
    let events=collect(&f,value).await.unwrap();
    let request=&f.generations()[0];
    assert_eq!(request["max_tokens"],512);assert_eq!(request["reasoning_budget_tokens"],256);
    assert_eq!(request["cache_prompt"],false);assert_eq!(request["chat_template_kwargs"]["enable_thinking"],true);
    assert!(events.iter().any(|event|matches!(event,ModelEvent::Data(value) if value.pointer("/choices/0/delta/reasoning_content").is_some())));
}

#[tokio::test]
async fn absent_native_capability_never_falls_back_to_native_tokenization() {
    let f=Fixture::new(vec![]).await;f.state.capability.store(false,Ordering::SeqCst);
    assert!(!f.engine.ready().await);
    assert_eq!(f.engine.prepare(&input(),&CancellationToken::new()).await.unwrap_err().status,503);
    assert!(f.generations().is_empty());assert!(f.tokenizer.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn missing_cleanup_capability_blocks_readiness_preparation_and_later_dispatch() {
    let f=Fixture::new(vec![Chunk::text("unexpected","stop",1)]).await;
    f.state.cleanup_capability.store(false,Ordering::SeqCst);
    assert!(!f.engine.ready().await);
    assert_eq!(f.engine.prepare(&input(),&CancellationToken::new()).await.unwrap_err().status,503);
    assert!(f.tokenizer.calls.lock().unwrap().is_empty());
    f.state.cleanup_capability.store(true,Ordering::SeqCst);
    let cancellation=CancellationToken::new();let prepared=f.engine.prepare(&input(),&cancellation).await.unwrap();
    f.state.cleanup_capability.store(false,Ordering::SeqCst);
    assert!(f.engine.generate(prepared,cancellation).await.is_err());
    assert!(f.generations().is_empty());
    assert!(!f.state.calls.lock().unwrap().iter().any(|(path,_)|path=="/tokenize"));
}

#[tokio::test]
async fn erase_requires_bounded_reviewed_endpoint_proof_not_just_success_status() {
    let bad_proofs=vec![
        json!({"id_slot":0,"n_erased":0}),
        json!({"offscript_erase_state_version":0,"id_slot":0,"n_erased":0}),
        json!({"offscript_erase_state_version":"1","id_slot":0,"n_erased":0}),
        json!({"offscript_erase_state_version":true,"id_slot":0,"n_erased":0}),
        json!({"offscript_erase_state_version":1,"id_slot":1,"n_erased":0}),
        json!({"offscript_erase_state_version":1,"id_slot":"0","n_erased":0}),
        json!({"offscript_erase_state_version":1,"id_slot":0}),
        json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":-1}),
        json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":4097}),
        json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":0.5}),
        json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":0,"padding":"x".repeat(16_385)}),
    ];
    for proof in bad_proofs {
        let f=Fixture::new(vec![]).await;
        *f.state.erase_reply.lock().unwrap()=proof;
        assert!(!f.engine.dispose().await);
        assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),3);
    }
    let f=Fixture::new(vec![]).await;
    // Empty initial cleanup and a full admitted context are both valid counts.
    for count in [0,4096] {
        *f.state.erase_reply.lock().unwrap()=json!({"offscript_erase_state_version":1,"id_slot":0,"n_erased":count});
        assert!(f.engine.dispose().await);
    }
}

#[tokio::test]
async fn unverified_final_erase_withholds_public_done_and_quarantines_admission() {
    let f=Fixture::new(vec![Chunk::text("Synthetic answer","stop",1)]).await;
    f.state.remove_erase_proof_after_generation.store(true,Ordering::SeqCst);
    let app=offscript_backend::gateway::router(offscript_backend::config::GatewayConfig::default(),f.engine.clone());
    let chat=||Request::builder().method("POST").uri("/api/chat").header("content-type","application/json")
        .header("x-offscript-client","web")
        .body(Body::from(json!({"messages":[{"role":"user","content":"Hello"}],"mode":"fast","maxTokens":256}).to_string())).unwrap();
    let response=app.clone().oneshot(chat()).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    let body=String::from_utf8(to_bytes(response.into_body(),65_536).await.unwrap().to_vec()).unwrap();
    assert!(body.contains("Synthetic answer"));
    assert!(!body.contains("data: [DONE]"));
    assert!(!body.contains("\"outcome\":\"completed\""));
    assert!(body.contains("\"workerStopped\":false"));
    assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),4); // Initial proof, then3failed final proofs.
    let health=app.clone().oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(health.status(),StatusCode::SERVICE_UNAVAILABLE);
    let value:Value=serde_json::from_slice(&to_bytes(health.into_body(),16_384).await.unwrap()).unwrap();
    assert_eq!(value["ready"],false);
    let second=app.oneshot(chat()).await.unwrap();
    assert_eq!(second.status(),StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.generations().len(),1);
}

#[tokio::test]
async fn readiness_has_one_total_budget_below_the_public_bridge_deadline() {
    let f=Fixture::new(vec![]).await;
    // Each dependency alone fits three seconds; their combined3.2s does not.
    f.state.props_delay_ms.store(1600,Ordering::SeqCst);
    f.state.health_delay_ms.store(1600,Ordering::SeqCst);
    assert!(!tokio::time::timeout(std::time::Duration::from_secs(5),f.engine.ready()).await.unwrap());
    assert!(f.generations().is_empty());
}

#[tokio::test]
async fn context_limits_and_long_prefix_budget_remain_unchanged() {
    let f=Fixture::new(vec![]).await;
    f.tokenizer.count.store(4090,Ordering::SeqCst);
    assert_eq!(f.engine.prepare(&input(),&CancellationToken::new()).await.unwrap_err().status,422);
    f.tokenizer.count.store(129,Ordering::SeqCst);
    let mut value=input();value.max_tokens=512;
    assert_eq!(f.engine.prepare(&value,&CancellationToken::new()).await.unwrap().output_budget,256);
    f.tokenizer.count.store(128,Ordering::SeqCst);
    assert_eq!(f.engine.prepare(&value,&CancellationToken::new()).await.unwrap().output_budget,512);
    assert!(f.generations().is_empty());
}

#[tokio::test]
async fn malformed_usage_template_changes_and_incomplete_streams_cannot_report_done() {
    for kind in ["usage","template","missing_done","type","empty"] {
        let mut chunk=Chunk::text("first","length",2);
        if kind=="usage" {chunk.tokens=3;}
        if kind=="missing_done" {chunk.no_done=true;}
        if kind=="type" {chunk.content=json!(42);}
        if kind=="empty" {chunk.content=json!("");chunk.tokens=0;}
        let f=Fixture::new(vec![chunk]).await;
        if kind=="template" {f.state.mismatched_continuation.store(true,Ordering::SeqCst);}
        let cancel=CancellationToken::new();let prepared=f.engine.prepare(&input(),&cancel).await.unwrap();
        let mut stream=f.engine.generate(prepared,cancel).await.unwrap();
        let mut error=false;
        while let Some(item)=stream.next().await {
            match item {Err(_)=>{error=true;break},Ok(ModelEvent::Done)=>panic!("Invalid stream reported Done"),_=>{}}
        }
        assert!(error,"{kind} did not fail");assert_eq!(f.generations().len(),1);
    }
}

#[tokio::test]
async fn stop_after_a_frame_does_not_dispatch_the_next_chunk() {
    let f=Fixture::new(vec![Chunk::text("first","length",2),Chunk::text("unexpected","stop",1)]).await;
    let cancel=CancellationToken::new();let prepared=f.engine.prepare(&input(),&cancel).await.unwrap();
    let mut stream=f.engine.generate(prepared,cancel.clone()).await.unwrap();
    assert!(matches!(stream.next().await,Some(Ok(ModelEvent::Data(_)))));
    cancel.cancel();drop(stream);
    tokio::task::yield_now().await;
    assert_eq!(f.generations().len(),1);
}

#[tokio::test]
async fn disposal_waits_for_cancelled_producer_owned_token_work_before_native_erasure() {
    let f=Fixture::new(vec![Chunk::text("first","length",2),Chunk::text("unexpected","stop",1)]).await;
    f.tokenizer.hold_continuation.store(true,Ordering::SeqCst);
    let cancel=CancellationToken::new();
    let prepared=f.engine.prepare(&input(),&cancel).await.unwrap();
    let mut stream=f.engine.generate(prepared,cancel.clone()).await.unwrap();
    assert!(matches!(stream.next().await,Some(Ok(ModelEvent::Data(_)))));
    {
        let next=stream.next();
        tokio::pin!(next);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                _=f.tokenizer.entered.notified()=>{},
                _=&mut next=>panic!("Held continuation unexpectedly returned"),
            }
        }).await.unwrap();
    }
    assert!(f.tokenizer.owns_text.load(Ordering::SeqCst));
    cancel.cancel();drop(stream);
    let engine=f.engine.clone();
    let cleanup=tokio::spawn(async move{engine.dispose().await});
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!cleanup.is_finished(),"Receiver drop was mistaken for producer quiescence");
    assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),0);
    f.tokenizer.release.notify_one();
    assert!(tokio::time::timeout(std::time::Duration::from_secs(2),cleanup).await.unwrap().unwrap());
    assert!(!f.tokenizer.owns_text.load(Ordering::SeqCst));
    assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),1);
    assert_eq!(f.generations().len(),1);
}

#[tokio::test]
async fn erasure_retries_are_bounded_and_untrusted_origins_are_rejected() {
    let f=Fixture::new(vec![]).await;f.state.erase_failures.store(2,Ordering::SeqCst);
    assert!(f.engine.dispose().await);assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),3);
    f.state.erase_failures.store(100,Ordering::SeqCst);assert!(!f.engine.dispose().await);
    assert_eq!(f.state.erase_calls.load(Ordering::SeqCst),6);
    for origin in ["https://127.0.0.1:8081","http://example.test:8081","http://127.0.0.1:8081/path","http://user@127.0.0.1:8081","http://127.0.0.1:8081/?x=1"] {
        assert!(LlamaEngine::new(origin,f.tokenizer.clone()).is_err());
    }
}
