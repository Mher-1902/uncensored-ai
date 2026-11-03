#![forbid(unsafe_code)]

pub mod config;
pub mod engine;
pub mod gateway;
pub mod registry;
pub mod request;
pub mod retrieval;
pub mod stream;
pub mod supervisor;
pub mod tokenizer;
pub mod transport;

#[derive(Debug, Clone)]
pub struct BackendError {
    pub status: u16,
    pub message: String,
    pub code: Option<&'static str>,
}

impl BackendError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), code: None }
    }
    pub fn busy() -> Self {
        Self { status: 503, message: "The model is busy. Please try again in a moment.".into(), code: Some("model_busy") }
    }
}
impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) }
}
impl std::error::Error for BackendError {}
