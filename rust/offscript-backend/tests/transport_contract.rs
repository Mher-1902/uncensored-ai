use std::{io, net::SocketAddr, pin::Pin, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc}, task::{Context, Poll}, time::Duration};

use axum::{body::{Body, Bytes}, response::Response, routing::get, Router};
use futures_util::{stream, Stream};
use offscript_backend::{transport::{serve_with_config, TransportConfig}, BackendError};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::Semaphore, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

type Server = JoinHandle<Result<(), BackendError>>;

async fn start(router: Router, config: TransportConfig) -> (SocketAddr, CancellationToken, Server) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let token = shutdown.clone();
    let server = tokio::spawn(async move { serve_with_config(listener, router, token, config, TaskTracker::new()).await });
    (address, shutdown, server)
}

fn counted(counter: Arc<AtomicUsize>) -> Router {
    Router::new().route("/", get(move || {
        let counter = counter.clone();
        async move { counter.fetch_add(1, Ordering::SeqCst); "ok" }
    }))
}

async fn header(socket: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        socket.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() <= 65_536);
        if bytes.ends_with(b"\r\n\r\n") { return String::from_utf8(bytes).unwrap(); }
    }
}

async fn response(socket: &mut TcpStream) -> String {
    let headers = header(socket).await;
    let size = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
    }).expect("fixed fixture content length");
    let mut body = vec![0; size]; socket.read_exact(&mut body).await.unwrap();
    headers + &String::from_utf8(body).unwrap()
}

#[tokio::test]
async fn incomplete_headers_expire_before_a_handler_receives_any_request() {
    let counter = Arc::new(AtomicUsize::new(0));
    let config = TransportConfig { header_timeout: Duration::from_millis(100), ..TransportConfig::default() };
    let (address, shutdown, server) = start(counted(counter.clone()), config).await;
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(b"GET / HTTP/1.1\r\nHost: test\r\nX-Incomplete:").await.unwrap();
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes)).await.expect("header deadline closes socket");
    assert!(!String::from_utf8_lossy(&bytes).contains("200 OK"));
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    shutdown.cancel(); assert!(server.await.unwrap().is_ok());
}

#[tokio::test]
async fn excessive_header_count_and_bytes_are_rejected_before_dispatch() {
    for (config, request) in [
        (TransportConfig { max_headers: 2, ..TransportConfig::default() }, "GET / HTTP/1.1\r\nHost: test\r\nX-One: 1\r\nX-Two: 2\r\n\r\n".to_owned()),
        (TransportConfig { max_buffer_bytes: 8192, ..TransportConfig::default() }, format!("GET / HTTP/1.1\r\nHost: test\r\nX-Large: {}\r\n\r\n", "x".repeat(9000))),
    ] {
        let counter = Arc::new(AtomicUsize::new(0));
        let (address, shutdown, server) = start(counted(counter.clone()), config).await;
        let mut socket = TcpStream::connect(address).await.unwrap();
        let _ = socket.write_all(request.as_bytes()).await;
        let mut bytes = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes)).await.expect("invalid header request closes");
        assert!(String::from_utf8_lossy(&bytes).contains("431"));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        shutdown.cancel(); assert!(server.await.unwrap().is_ok());
    }
}

#[tokio::test]
async fn active_connection_limit_closes_excess_connections_and_releases_on_close() {
    let counter = Arc::new(AtomicUsize::new(0));
    let config = TransportConfig { max_connections: 1, header_timeout: Duration::from_secs(5), ..TransportConfig::default() };
    let (address, shutdown, server) = start(counted(counter.clone()), config).await;
    let mut first = TcpStream::connect(address).await.unwrap();
    first.write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n").await.unwrap();
    assert!(response(&mut first).await.contains("200 OK"));
    let mut excess = TcpStream::connect(address).await.unwrap();
    let _ = excess.write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n").await;
    let mut rejected = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), excess.read_to_end(&mut rejected)).await.expect("excess connection closes");
    assert!(!String::from_utf8_lossy(&rejected).contains("200 OK")); assert_eq!(counter.load(Ordering::SeqCst), 1);
    first.shutdown().await.unwrap();
    let mut remaining = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), first.read_to_end(&mut remaining)).await.expect("closed peer releases server connection");
    let mut next = TcpStream::connect(address).await.unwrap();
    next.write_all(b"GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n").await.unwrap();
    assert!(response(&mut next).await.contains("200 OK")); assert_eq!(counter.load(Ordering::SeqCst), 2);
    shutdown.cancel(); assert!(server.await.unwrap().is_ok());
}

#[tokio::test]
async fn idle_keepalive_does_not_retain_a_connection_indefinitely() {
    let counter = Arc::new(AtomicUsize::new(0));
    let config = TransportConfig { header_timeout: Duration::from_millis(100), ..TransportConfig::default() };
    let (address, shutdown, server) = start(counted(counter.clone()), config).await;
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n").await.unwrap();
    assert!(response(&mut socket).await.contains("200 OK"));
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes)).await.expect("idle keepalive bounded by header timer");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    shutdown.cancel(); assert!(server.await.unwrap().is_ok());
}

struct ObservedBody {
    source: Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>,
    dropped: Arc<AtomicBool>,
}
impl Stream for ObservedBody {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> { self.source.as_mut().poll_next(context) }
}
impl Drop for ObservedBody {
    fn drop(&mut self) { self.dropped.store(true, Ordering::SeqCst); }
}

fn held_body(release: Arc<Semaphore>, dropped: Arc<AtomicBool>) -> Router {
    Router::new().route("/", get(move || {
        let release = release.clone(); let dropped = dropped.clone();
        async move {
            let source = stream::unfold((false, release), |(sent, release)| async move {
                if !sent { Some((Ok(Bytes::from_static(b"x")), (true, release))) }
                else { release.acquire().await.unwrap().forget(); None }
            });
            Response::new(Body::from_stream(ObservedBody { source: Box::pin(source), dropped }))
        }
    }))
}

#[tokio::test]
async fn graceful_shutdown_waits_for_active_response_cleanup_and_closes_keepalive() {
    let release = Arc::new(Semaphore::new(0)); let dropped = Arc::new(AtomicBool::new(false));
    let config = TransportConfig { shutdown_timeout: Duration::from_secs(3), ..TransportConfig::default() };
    let (address, shutdown, server) = start(held_body(release.clone(), dropped.clone()), config).await;
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n").await.unwrap();
    assert!(header(&mut socket).await.contains("200 OK"));
    shutdown.cancel(); tokio::task::yield_now().await;
    assert!(!server.is_finished()); assert!(!dropped.load(Ordering::SeqCst));
    release.add_permits(1);
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes)).await.expect("drained response closes");
    assert!(server.await.unwrap().is_ok()); assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn process_shutdown_deadline_forces_close_and_reports_incomplete_drain() {
    let release = Arc::new(Semaphore::new(0)); let dropped = Arc::new(AtomicBool::new(false));
    let config = TransportConfig { shutdown_timeout: Duration::from_millis(100), ..TransportConfig::default() };
    let (address, shutdown, server) = start(held_body(release, dropped.clone()), config).await;
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n").await.unwrap();
    assert!(header(&mut socket).await.contains("200 OK")); shutdown.cancel();
    let result = tokio::time::timeout(Duration::from_secs(3), server).await.expect("bounded process shutdown").unwrap();
    assert!(result.is_err()); assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn invalid_transport_limits_fail_without_serving() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let result = serve_with_config(listener, Router::new(), CancellationToken::new(), TransportConfig {
        max_buffer_bytes: 1, ..TransportConfig::default()
    }, TaskTracker::new()).await;
    assert!(result.is_err());
}
