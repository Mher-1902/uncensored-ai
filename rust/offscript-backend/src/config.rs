use std::{collections::HashSet, time::Duration};

#[derive(Clone)]
pub struct GatewayConfig {
    pub access_token: Option<String>,
    pub origins: HashSet<String>,
    pub queue_limit: usize,
    pub queue_timeout: Duration,
    pub generation_timeout: Duration,
    pub thermal_root: Option<std::path::PathBuf>,
    pub shutdown: tokio_util::sync::CancellationToken,
    pub workers: tokio_util::task::TaskTracker,
}
impl Default for GatewayConfig {
    fn default() -> Self {
        Self { access_token: None, origins: HashSet::new(), queue_limit: 1,
            queue_timeout: Duration::from_secs(10), generation_timeout: Duration::from_secs(300), thermal_root: None,
            shutdown: tokio_util::sync::CancellationToken::new(), workers: tokio_util::task::TaskTracker::new() }
    }
}
