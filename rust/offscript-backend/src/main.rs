#![forbid(unsafe_code)]
use std::{io::{Read, Write}, net::{IpAddr, SocketAddr}, path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant}};
use offscript_backend::{config::GatewayConfig, engine::LlamaEngine, gateway, supervisor, transport, tokenizer::{LocalTokenizer, Tokenizer}, BackendError};
use serde_json::{json, Value};
use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

fn root() -> PathBuf { std::env::var_os("OFFSCRIPT_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/app")) }
fn local_tokenizer(root: &Path) -> Result<LocalTokenizer, BackendError> {
    let config = supervisor::read_model_config(&root.join("self-host/model.json"))?;
    let directory = std::env::var_os("OFFSCRIPT_TOKENIZER_DIR").map(PathBuf::from).unwrap_or_else(|| root.join(".data/tokenizer"));
    LocalTokenizer::load_selected(&directory, &config.sha256)
}
async fn health(model_only: bool) -> Result<(), BackendError> {
    let port = if model_only {8081} else {8080};
    let path = if model_only {"health"} else {"api/health"};
    let response = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(4)).build()
        .map_err(|_| BackendError::new(503,"Health check unavailable."))?
        .get(format!("http://127.0.0.1:{port}/{path}")).send().await.map_err(|_| BackendError::new(503,"Health check failed."))?;
    if !response.status().is_success() {return Err(BackendError::new(503,"Service is not ready."));}
    if !model_only {
        let value: Value = response.json().await.map_err(|_| BackendError::new(503,"Invalid readiness response."))?;
        if value.get("ready")!=Some(&Value::Bool(true)) {return Err(BackendError::new(503,"Service is not ready."));}
    }
    Ok(())
}

async fn worker_evidence() -> Result<(), BackendError> {
    let client=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(2)).build()
        .map_err(|_|BackendError::new(503,"Worker evidence unavailable."))?;
    let response=client.get("http://127.0.0.1:8080/api/health").send().await.map_err(|_|BackendError::new(503,"Worker evidence unavailable."))?;
    if ![200,503].contains(&response.status().as_u16()) {return Err(BackendError::new(503,"Worker evidence unavailable."));}
    let mut stream=response.bytes_stream();let mut bytes=Vec::new();
    while let Some(part)=stream.next().await {
        let part=part.map_err(|_|BackendError::new(503,"Worker evidence unavailable."))?;
        if bytes.len()+part.len()>16384 {return Err(BackendError::new(503,"Worker evidence unavailable."));}
        bytes.extend_from_slice(&part);
    }
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|BackendError::new(503,"Worker evidence unavailable."))?;
    let id=value.get("workerId").and_then(Value::as_str).and_then(|id|uuid::Uuid::parse_str(id).ok())
        .filter(|id|id.get_version_num()==4).ok_or_else(||BackendError::new(503,"Worker evidence unavailable."))?;
    if value.get("protocol").and_then(Value::as_u64)!=Some(5) {return Err(BackendError::new(503,"Worker evidence unavailable."));}
    println!("{}",json!({"protocol":5,"workerId":id}));Ok(())
}

async fn run() -> Result<(), BackendError> {
    match std::env::args().nth(1).as_deref() {
        Some("supervise") => supervisor::run(&root()).await,
        Some("check-model") => health(true).await,
        Some("check-gateway") => health(false).await,
        Some("worker-evidence") => worker_evidence().await,
        Some("tokenize") => {
            let tokenizer=local_tokenizer(&root())?;
            let mut bytes=Vec::new();std::io::stdin().take(4_194_305).read_to_end(&mut bytes).map_err(|_|BackendError::new(400,"Input unavailable."))?;
            if bytes.len()>4_194_304 {return Err(BackendError::new(413,"Tokenization input is too large."));}
            let value:Value=serde_json::from_slice(&bytes).map_err(|_|BackendError::new(400,"Send JSON."))?;
            let batch=value.get("inputs").and_then(Value::as_array);
            let inputs=if let Some(batch)=batch {batch.clone()} else {vec![value.get("content").cloned().unwrap_or(Value::Null)]};
            if inputs.is_empty() || inputs.len()>256 {return Err(BackendError::new(400,"Invalid tokenization batch."));}
            let mut results=Vec::new();
            for input in inputs {
                let prompt=input.as_str().ok_or_else(||BackendError::new(400,"Tokenization input must be text."))?;
                let start=Instant::now();let tokens=tokenizer.encode(prompt,&CancellationToken::new()).await?;
                results.push(json!({"tokens":tokens,"encodeMicros":start.elapsed().as_micros()}));
            }
            let result=if batch.is_some(){json!({"results":results})}else{results.remove(0)};
            serde_json::to_writer(std::io::stdout().lock(),&result).map_err(|_|BackendError::new(500,"Output unavailable."))?;
            std::io::stdout().write_all(b"\n").map_err(|_|BackendError::new(500,"Output unavailable."))?;
            Ok(())
        }
        Some("gateway") => {
            let token=std::env::var("GATEWAY_ACCESS_TOKEN").map_err(|_| BackendError::new(500,"Service credential is required."))?;
            if !(32..=256).contains(&token.len()) || !token.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_' || c==b'-') {return Err(BackendError::new(500,"Invalid service credential."));}
            let host:IpAddr=std::env::var("HOST").unwrap_or_else(|_|"127.0.0.1".into()).parse().map_err(|_|BackendError::new(500,"Invalid listener."))?;
            let port:u16=std::env::var("PORT").unwrap_or_else(|_|"8080".into()).parse().map_err(|_|BackendError::new(500,"Invalid listener."))?;
            let mut config=GatewayConfig {access_token:Some(token),thermal_root:Some(PathBuf::from("/sys/class/hwmon")),..GatewayConfig::default()};
            let public_api_origin=std::env::var("PUBLIC_API_ORIGIN").ok().filter(|value|!value.is_empty());
            if let Some(ref origin)=public_api_origin {
                let url=reqwest::Url::parse(origin).map_err(|_|BackendError::new(500,"Invalid API origin."))?;
                if url.scheme()!="https" || url.origin().ascii_serialization()!=*origin {return Err(BackendError::new(500,"Invalid API origin."));}
            }
            for origin in [std::env::var("PUBLIC_ORIGIN").unwrap_or_else(|_|"https://offscript-ai.vercel.app".into()),format!("http://127.0.0.1:{port}"),format!("http://localhost:{port}")].into_iter().chain(public_api_origin) {
                let url=reqwest::Url::parse(&origin).map_err(|_|BackendError::new(500,"Invalid allowed origin."))?;
                if url.origin().ascii_serialization()!=origin || !matches!(url.scheme(),"http"|"https") {return Err(BackendError::new(500,"Invalid allowed origin."));}
                config.origins.insert(origin);
            }
            let tokenizer=Arc::new(local_tokenizer(&root())?);
            let engine=Arc::new(LlamaEngine::new(&std::env::var("LLAMA_URL").unwrap_or_else(|_|"http://127.0.0.1:8081".into()),tokenizer)?);
            let listener=tokio::net::TcpListener::bind(SocketAddr::new(host,port)).await.map_err(|_|BackendError::new(500,"Could not bind the gateway."))?;
            eprintln!("Offscript Rust gateway listening; prompt logging disabled.");
            let shutdown=config.shutdown.clone();let signal_shutdown=shutdown.clone();let workers=config.workers.clone();
            tokio::spawn(async move {
                let mut term=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
                signal_shutdown.cancel();
            });
            transport::serve(listener,gateway::router(config,engine),shutdown,workers).await
        }
        _ => Err(BackendError::new(400,"Use gateway, supervise, check-model, check-gateway, worker-evidence or tokenize.")),
    }
}

#[tokio::main(flavor="multi_thread",worker_threads=1)]
async fn main() {
    if let Err(error)=run().await {eprintln!("{}",error.message);std::process::exit(1);}
}
