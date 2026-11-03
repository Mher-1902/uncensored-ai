//! Bounded HTTP/1 transport for the private gateway. It never records request
//! headers, bodies, peer addresses or native diagnostics.
use std::{sync::Arc, time::Duration};

use axum::Router;
use hyper::server::conn::http1;
use hyper_util::{rt::{TokioIo, TokioTimer}, service::TowerToHyperService};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::BackendError;

#[derive(Debug, Clone)]
pub struct TransportConfig {
    pub header_timeout: Duration,
    pub max_headers: usize,
    pub max_buffer_bytes: usize,
    pub max_connections: usize,
    pub shutdown_timeout: Duration,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self { header_timeout: Duration::from_secs(10), max_headers: 100, max_buffer_bytes: 65_536,
            max_connections: 128, shutdown_timeout: Duration::from_secs(30) }
    }
}

impl TransportConfig {
    fn validate(&self) -> Result<(), BackendError> {
        if self.header_timeout.is_zero() || self.header_timeout > Duration::from_secs(10)
            || !(1..=100).contains(&self.max_headers) || !(8192..=65_536).contains(&self.max_buffer_bytes)
            || !(1..=128).contains(&self.max_connections) || self.shutdown_timeout.is_zero()
            || self.shutdown_timeout > Duration::from_secs(30) {
            return Err(BackendError::new(500, "Invalid gateway transport limits."));
        }
        Ok(())
    }
}

pub async fn serve(listener: TcpListener, router: Router, shutdown: CancellationToken, workers: TaskTracker) -> Result<(), BackendError> {
    serve_with_config(listener, router, shutdown, TransportConfig::default(), workers).await
}

/// Configurable lower bounds are exposed for isolated TCP fixtures. Callers
/// cannot use this API to exceed the reviewed production transport limits.
pub async fn serve_with_config(listener: TcpListener, router: Router, shutdown: CancellationToken,
    config: TransportConfig, workers: TaskTracker) -> Result<(), BackendError> {
    config.validate()?;
    let permits = Arc::new(Semaphore::new(config.max_connections));
    let mut connections = JoinSet::new();
    let mut listener_failed = false;
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            result = listener.accept() => {
                let (socket, _) = match result {
                    Ok(value) => value,
                    Err(_) => { listener_failed = true; shutdown.cancel(); break; },
                };
                let permit = match permits.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    // Close before parsing or allocating per-request buffers.
                    Err(_) => { drop(socket); continue; },
                };
                let _ = socket.set_nodelay(true);
                let router = router.clone();
                let shutdown = shutdown.clone();
                let config = config.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    let mut builder = http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(config.header_timeout)
                        .max_headers(config.max_headers).max_buf_size(config.max_buffer_bytes)
                        .max_header_size(config.max_buffer_bytes).keep_alive(true).half_close(false);
                    let connection = builder.serve_connection(TokioIo::new(socket), TowerToHyperService::new(router));
                    tokio::pin!(connection);
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = connection.await;
                        },
                        _ = connection.as_mut() => {},
                    }
                });
            },
        }
    }
    drop(listener);
    workers.close();
    // The router receives the same shutdown token and cancels workers at the
    // beginning of this grace period. HTTP bodies remain alive long enough to
    // carry confirmed cleanup; only the process shutdown deadline forces close.
    let drained = tokio::time::timeout(config.shutdown_timeout, async {
        while connections.join_next().await.is_some() {}
        // A disconnected response cancels its model worker, but that worker may
        // still own tokenization buffers or await native slot erasure. Once all
        // handlers have ended no new worker can be registered; wait for every
        // tracked lifecycle within the SAME process shutdown deadline.
        workers.wait().await;
    }).await.is_ok();
    if !drained {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        return Err(BackendError::new(503, "Gateway shutdown exceeded its cleanup deadline."));
    }
    if listener_failed { return Err(BackendError::new(500, "Gateway listener failed.")); }
    Ok(())
}
