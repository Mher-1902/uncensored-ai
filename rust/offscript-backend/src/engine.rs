//! The model-specific contract: Rust input tokens, native reasoning parser,
//! bounded continuation, cancellation and confirmed slot erasure.
use async_trait::async_trait;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, task::{Context, Poll}, time::Duration};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_util::sync::CancellationToken;

use crate::{request::{ChatInput, Message, Mode}, stream::SseReader, tokenizer::Tokenizer, BackendError};

#[derive(Clone, Debug)]
pub struct Prepared {
    pub input: ChatInput,
    pub prompt: String,
    pub input_tokens: Vec<u32>,
    pub output_budget: usize,
    pub reasoning_budget: usize,
}

#[derive(Clone, Debug)]
pub enum ModelEvent { Data(Value), Done }
pub type EngineStream = Pin<Box<dyn Stream<Item = Result<ModelEvent, BackendError>> + Send>>;

#[async_trait]
pub trait Engine: Send + Sync {
    async fn ready(&self) -> bool;
    async fn dispose(&self) -> bool;
    async fn prepare(&self, input: &ChatInput, cancel: &CancellationToken) -> Result<Prepared, BackendError>;
    async fn generate(&self, prepared: Prepared, cancel: CancellationToken) -> Result<EngineStream, BackendError>;
}

#[derive(Clone)]
pub struct LlamaEngine {
    base: reqwest::Url,
    client: reqwest::Client,
    tokenizer: Arc<dyn Tokenizer>,
    context_tokens: usize,
    chunk_tokens: usize,
    producers: Arc<Producers>,
}

#[derive(Default)]
struct Producers {
    next: AtomicU64,
    active: Mutex<HashMap<u64, CancellationToken>>,
    changed: Notify,
}

impl Producers {
    fn register(self: &Arc<Self>, cancellation: CancellationToken) -> ProducerGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.active.lock().expect("producer registry lock").insert(id, cancellation);
        ProducerGuard { owner: self.clone(), id }
    }

    async fn cancel_and_wait(&self) -> bool {
        let waiting = async {
            loop {
                // Register interest BEFORE checking state: a producer can finish
                // between the check and await, without losing its notification.
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let tokens: Vec<_> = self.active.lock().expect("producer registry lock").values().cloned().collect();
                if tokens.is_empty() { return; }
                for token in tokens { token.cancel(); }
                changed.await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), waiting).await.is_ok()
    }
}

// The producer owns the rendered prompt, messages, tokenizer work and reader.
// Cancellation requests Stop; only this guard's destruction confirms that the
// async producer actually returned/unwound. No task is aborted or detached from
// its cleanup accounting merely because its output receiver disappeared.
struct ProducerGuard { owner: Arc<Producers>, id: u64 }
impl Drop for ProducerGuard {
    fn drop(&mut self) {
        self.owner.active.lock().expect("producer registry lock").remove(&self.id);
        self.owner.changed.notify_waiters();
    }
}

fn interrupted() -> BackendError { BackendError::new(499, "Request cancelled.") }
fn generation_error() -> BackendError { BackendError::new(502, "The model could not safely complete this answer. The text received so far is kept.") }
fn utf16_len(value: &str) -> usize { value.encode_utf16().count() }

impl LlamaEngine {
    pub fn new(origin: &str, tokenizer: Arc<dyn Tokenizer>) -> Result<Self, BackendError> {
        Self::with_limits(origin, tokenizer, 4096, 256)
    }

    pub fn with_limits(origin: &str, tokenizer: Arc<dyn Tokenizer>, context_tokens: usize, chunk_tokens: usize) -> Result<Self, BackendError> {
        let base = reqwest::Url::parse(origin).map_err(|_| BackendError::new(500, "Invalid model origin."))?;
        if base.scheme() != "http" || !matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"))
            || !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() || base.path() != "/"
            || chunk_tokens == 0 || chunk_tokens > 256 || context_tokens != 4096 {
            return Err(BackendError::new(500, "The model listener must be a loopback HTTP origin with the reviewed context."));
        }
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(3))
            .build().map_err(|_| BackendError::new(500, "Could not initialize the model client."))?;
        Ok(Self { base, client, tokenizer, context_tokens, chunk_tokens, producers: Arc::new(Producers::default()) })
    }

    fn url(&self, path: &str) -> reqwest::Url { self.base.join(path).expect("static model route") }

    async fn json_response(&self, response: reqwest::Response, cancel: &CancellationToken, limit: usize) -> Result<Value, BackendError> {
        if !response.status().is_success() { return Err(generation_error()); }
        let mut source = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! { biased; _ = cancel.cancelled() => return Err(interrupted()), next = source.next() => next };
            match next {
                Some(Ok(part)) => {
                    if bytes.len().saturating_add(part.len()) > limit { return Err(generation_error()); }
                    bytes.extend_from_slice(&part);
                }
                Some(Err(_)) => return Err(generation_error()),
                None => return serde_json::from_slice(&bytes).map_err(|_| generation_error()),
            }
        }
    }

    async fn capability(&self, cancel: &CancellationToken) -> Result<(), BackendError> {
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(interrupted()),
            result = self.client.get(self.url("/props")).timeout(Duration::from_secs(3)).send() => result.map_err(|_| BackendError::new(503, "The Rust input-token interface is unavailable."))?,
        };
        let props = self.json_response(response, cancel, 262144).await?;
        if props.get("offscript_input_tokens_version").and_then(Value::as_u64) != Some(1) {
            return Err(BackendError::new(503, "The model does not support the Rust input-token interface."));
        }
        if props.get("offscript_erase_state_version").and_then(Value::as_u64) != Some(1) {
            return Err(BackendError::new(503, "The model does not support verified state cleanup."));
        }
        Ok(())
    }

    async fn start_chunk(&self, prepared: &Prepared, cancel: &CancellationToken, reuse: bool) -> Result<SseReader, BackendError> {
        // Checking here as well as at prepare/health prevents an engine restart
        // from turning an unknown private field into silent C++ tokenization.
        self.capability(cancel).await?;
        let reasoning = prepared.input.mode == Mode::Deep;
        let mut body = json!({
            "model":"offscript", "messages":prepared.input.messages,
            "stream":true, "stream_options":{"include_usage":true},
            "max_tokens":if reuse { self.chunk_tokens.min(prepared.output_budget) } else { prepared.output_budget },
            "temperature":if reasoning { 0.6 } else { 0.7 },
            "top_p":if reasoning { 0.95 } else { 0.8 }, "top_k":20, "min_p":0,
            "chat_template_kwargs":{"enable_thinking":reasoning},
            "cache_prompt":reuse, "id_slot":0,
            "offscript_prompt_tokens":prepared.input_tokens,
            "offscript_rendered_prompt":prepared.prompt,
        });
        if prepared.input.continuation {
            body["continue_final_message"] = json!("content");
            body["add_generation_prompt"] = json!(false);
        }
        if reasoning { body["reasoning_budget_tokens"] = json!(prepared.reasoning_budget); }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(interrupted()),
            response = self.client.post(self.url("/v1/chat/completions")).json(&body).send() => response.map_err(|_| generation_error())?,
        };
        if !response.status().is_success() || response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|h|h.to_str().ok()).and_then(|h|h.split(';').next()) != Some("text/event-stream") {
            return Err(generation_error());
        }
        let bytes = response.bytes_stream().map(|part| part.map_err(|_| generation_error()));
        Ok(SseReader::new(Box::pin(bytes), cancel.clone()))
    }

    async fn run_stream(&self, original: Prepared, mut reader: SseReader, cancel: CancellationToken, sender: &mpsc::Sender<Envelope>) -> Result<(), BackendError> {
        let chunked = original.input.mode == Mode::Fast && original.output_budget > self.chunk_tokens;
        let mut current = original.clone();
        let mut text = String::new();
        let mut used = 0usize;
        let mut initial_prompt_tokens = None;
        for _ in 0..16 {
            let mut chunk = String::new();
            let mut finish: Option<String> = None;
            let mut usage: Option<(usize, usize)> = None;
            let mut done = false;
            let mut bytes = 0usize;
            while let Some(raw) = reader.next_event().await? {
                if cancel.is_cancelled() { return Err(interrupted()); }
                bytes = bytes.saturating_add(raw.len());
                if bytes > 2_097_152 { return Err(generation_error()); }
                if raw == "[DONE]" { done = true; break; }
                let event: Value = serde_json::from_str(&raw).map_err(|_| generation_error())?;
                if !event.is_object() || event.get("error").is_some() { return Err(generation_error()); }
                let choice = event.get("choices").and_then(Value::as_array).and_then(|values|values.first());
                if chunked && choice.and_then(|c|c.pointer("/delta/reasoning_content")).is_some_and(|v| !v.is_null() && v != "") {
                    return Err(generation_error());
                }
                if let Some(content) = choice.and_then(|c|c.pointer("/delta/content")).filter(|v|!v.is_null()) {
                    let content = content.as_str().ok_or_else(generation_error)?;
                    if utf16_len(&text).saturating_add(utf16_len(&chunk)).saturating_add(utf16_len(content)) > 65536 { return Err(generation_error()); }
                    chunk.push_str(content);
                    if chunked && !content.is_empty() {
                        send(sender, &cancel, ModelEvent::Data(json!({"choices":[{"delta":{"content":content},"finish_reason":null}]}))).await?;
                    }
                }
                if let Some(reason) = choice.and_then(|c|c.get("finish_reason")).filter(|v|!v.is_null()) {
                    let reason = reason.as_str().ok_or_else(generation_error)?;
                    if !["stop", "length"].contains(&reason) || finish.as_ref().is_some_and(|old| old != reason) { return Err(generation_error()); }
                    finish = Some(reason.into());
                }
                if let Some(value) = event.get("usage") {
                    let prompt = value.get("prompt_tokens").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or_else(generation_error)?;
                    let completion = value.get("completion_tokens").and_then(Value::as_u64).and_then(|n|usize::try_from(n).ok()).ok_or_else(generation_error)?;
                    usage = Some((prompt, completion));
                }
                if !chunked { send(sender, &cancel, ModelEvent::Data(event)).await?; }
            }
            let (prompt_tokens, completion_tokens) = usage.ok_or_else(generation_error)?;
            let finish = finish.ok_or_else(generation_error)?;
            let limit = if chunked { self.chunk_tokens.min(current.output_budget) } else { current.output_budget };
            if !done || completion_tokens > limit || prompt_tokens.saturating_add(completion_tokens) > self.context_tokens
                || (finish == "length" && (chunk.is_empty() || completion_tokens == 0)) { return Err(generation_error()); }
            if !chunked {
                send(sender, &cancel, ModelEvent::Done).await?;
                return Ok(());
            }
            let first_prompt = *initial_prompt_tokens.get_or_insert(prompt_tokens);
            used = used.checked_add(completion_tokens).ok_or_else(generation_error)?;
            text.push_str(&chunk);
            if used > original.output_budget || first_prompt.saturating_add(used) > self.context_tokens { return Err(generation_error()); }
            if finish == "stop" || used == original.output_budget {
                send(sender, &cancel, ModelEvent::Data(json!({
                    "choices":[{"delta":{},"finish_reason":finish}],
                    "usage":{"prompt_tokens":first_prompt,"completion_tokens":used,"total_tokens":first_prompt+used}
                }))).await?;
                send(sender, &cancel, ModelEvent::Done).await?;
                return Ok(());
            }
            let mut input = original.input.clone();
            input.mode = Mode::Fast;
            input.continuation = true;
            input.max_tokens = original.output_budget - used;
            if original.input.continuation {
                input.messages.last_mut().ok_or_else(generation_error)?.content.push_str(&text);
            } else {
                input.messages.push(Message { role: "assistant".into(), content: text.clone() });
            }
            let next = self.prepare(&input, &cancel).await?;
            if next.prompt != format!("{}{}", current.prompt, chunk) { return Err(generation_error()); }
            current = next;
            reader = self.start_chunk(&current, &cancel, true).await?;
        }
        Err(generation_error())
    }
}

struct Envelope {
    item: Result<ModelEvent, BackendError>,
    acknowledged: Option<oneshot::Sender<()>>,
}

async fn send(sender: &mpsc::Sender<Envelope>, cancel: &CancellationToken, event: ModelEvent) -> Result<(), BackendError> {
    let data = matches!(&event, ModelEvent::Data(_));
    let (acknowledged, consumed) = oneshot::channel();
    let item = Envelope { item: Ok(event), acknowledged: data.then_some(acknowledged) };
    tokio::select! { biased; _ = cancel.cancelled() => return Err(interrupted()), result = sender.send(item) => result.map_err(|_| interrupted())? }
    if data {
        // A continuation cannot begin until the consumer asks for the next
        // event. Merely buffering a frame is not permission to compute ahead.
        tokio::select! { biased; _ = cancel.cancelled() => Err(interrupted()), result = consumed => result.map_err(|_| interrupted()) }
    } else { Ok(()) }
}

struct CancelOnDrop {
    receiver: mpsc::Receiver<Envelope>,
    cancel: CancellationToken,
    acknowledged: Option<oneshot::Sender<()>>,
}
impl Stream for CancelOnDrop {
    type Item = Result<ModelEvent, BackendError>;
    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if let Some(acknowledged) = this.acknowledged.take() { let _ = acknowledged.send(()); }
        match this.receiver.poll_recv(context) {
            Poll::Ready(Some(envelope)) => { this.acknowledged = envelope.acknowledged; Poll::Ready(Some(envelope.item)) }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for CancelOnDrop { fn drop(&mut self) { self.cancel.cancel(); } }

#[async_trait]
impl Engine for LlamaEngine {
    async fn ready(&self) -> bool {
        let cancel = CancellationToken::new();
        let check = async {
            self.tokenizer.ready().await && self.capability(&cancel).await.is_ok()
                && self.client.get(self.url("/health")).timeout(Duration::from_secs(3)).send().await.is_ok_and(|r|r.status().is_success())
        };
        // The Vercel bridge allows five seconds end-to-end. Two sequential
        // three-second HTTP budgets must not accidentally become six seconds.
        tokio::time::timeout(Duration::from_secs(3), check).await.unwrap_or(false)
    }

    async fn dispose(&self) -> bool {
        // Never acknowledge slot erasure while a cancelled continuation still
        // owns prompt text or waits for its non-abortable Rust encode job.
        if !self.producers.cancel_and_wait().await { return false; }
        for _ in 0..3 {
            let attempt = async {
                let Ok(response) = self.client.post(self.url("/slots/0?action=erase")).timeout(Duration::from_secs(5)).send().await else { return false; };
                // A generic 2xx is not proof that the reviewed endpoint dropped
                // the previous task, sampler and hybrid/checkpoint references.
                // This independent token must remain usable after client Stop.
                let cleanup = CancellationToken::new();
                let Ok(proof) = self.json_response(response, &cleanup, 16_384).await else { return false; };
                proof.get("offscript_erase_state_version").and_then(Value::as_u64) == Some(1)
                    && proof.get("id_slot").and_then(Value::as_u64) == Some(0)
                    && proof.get("n_erased").and_then(Value::as_u64).is_some_and(|count| count <= self.context_tokens as u64)
            };
            if tokio::time::timeout(Duration::from_secs(5), attempt).await.unwrap_or(false) { return true; }
        }
        false
    }

    async fn prepare(&self, input: &ChatInput, cancel: &CancellationToken) -> Result<Prepared, BackendError> {
        self.capability(cancel).await?;
        let reasoning = input.mode == Mode::Deep;
        let mut body = json!({"messages":input.messages,"chat_template_kwargs":{"enable_thinking":reasoning}});
        if input.continuation { body["continue_final_message"] = json!("content"); body["add_generation_prompt"] = json!(false); }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(interrupted()),
            response = self.client.post(self.url("/apply-template")).json(&body).send() => response.map_err(|_| BackendError::new(502, "Could not prepare the model prompt."))?,
        };
        let value = self.json_response(response, cancel, 262144).await?;
        let prompt = value.get("prompt").and_then(Value::as_str).ok_or_else(|| BackendError::new(502, "The model returned an invalid template."))?.to_owned();
        let input_tokens = self.tokenizer.encode(&prompt, cancel).await?;
        let remaining = self.context_tokens.saturating_sub(input_tokens.len());
        if input_tokens.is_empty() { return Err(BackendError::new(502, "The tokenizer returned an invalid token count.")); }
        if remaining < if reasoning { 128 } else { 32 } {
            return Err(BackendError::new(422, "This conversation has filled the model context. Start a new chat for another answer. Nothing was silently removed."));
        }
        let visible = if reasoning { input.max_tokens } else { input.max_tokens.min(if input_tokens.len() > 128 { 256 } else { 512 }) };
        let output_budget = visible.saturating_add(if reasoning { 256 } else { 0 }).min(remaining);
        let reasoning_budget = if reasoning { 256.min(output_budget - 128) } else { 0 };
        Ok(Prepared { input: input.clone(), prompt, input_tokens, output_budget, reasoning_budget })
    }

    async fn generate(&self, prepared: Prepared, cancel: CancellationToken) -> Result<EngineStream, BackendError> {
        let cancel = cancel.child_token();
        // Register before the first request/spawn so cancellation cannot leave
        // an untracked producer in a start-up race.
        let producer = self.producers.register(cancel.clone());
        // Move the argument into a newer local: on an early dispatch error its
        // prompt/token buffers are dropped before the older quiescence guard.
        let prepared = prepared;
        let reuse = prepared.input.mode == Mode::Fast && prepared.output_budget > self.chunk_tokens;
        let first = self.start_chunk(&prepared, &cancel, reuse).await?;
        let (sender, receiver) = mpsc::channel(1);
        let engine = self.clone();
        let worker_cancel = cancel.clone();
        tokio::spawn(async move {
            // Declared before the owned generation future so its data/reader
            // drop before this guard signals quiescence, including unwinding.
            let _producer = producer;
            if let Err(error) = engine.run_stream(prepared, first, worker_cancel.clone(), &sender).await {
                tokio::select! { biased; _ = worker_cancel.cancelled() => {}, _ = sender.send(Envelope { item: Err(error), acknowledged: None }) => {} }
            }
        });
        Ok(Box::pin(CancelOnDrop { receiver, cancel, acknowledged: None }))
    }
}
