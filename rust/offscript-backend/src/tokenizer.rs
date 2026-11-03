//! Input tokenization is Rust, not an FFI call to the native inference library.
use std::{collections::HashMap, io::{Read, Seek, SeekFrom}, path::Path, sync::Arc};
use async_trait::async_trait;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokenizers::{models::bpe::{BPE,Vocab}, AddedToken, Tokenizer as HfTokenizer};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use crate::BackendError;

const MAX_PROMPT_BYTES: usize = 131_072;
const MAX_ARTIFACT_BYTES: u64 = 33_554_432;
const SELECTED_MODEL_SHA256: &str = "be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517";
// Independently reproduced from the selected GGUF by both exporters and
// checked against the pinned native tokenizer. A mounted manifest cannot
// declare a different mapping/BOS policy merely by updating its own checksum.
const SELECTED_TOKENIZER_SHA256: &str = "870f52c96c79b41a014df678d5b7078850e11607914adeed854c0ec424f3b407";

#[async_trait]
pub trait Tokenizer: Send + Sync {
    async fn ready(&self) -> bool;
    async fn encode(&self, prompt: &str, cancel: &CancellationToken) -> Result<Vec<u32>, BackendError>;
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenizerManifest {
    pub schema: u32,
    pub model_sha256: String,
    pub tokenizer_sha256: String,
    pub vocab_count: usize,
    pub merge_count: usize,
    pub pre: String,
    pub add_bos: bool,
    pub bos_token_id: Option<u32>,
}

pub struct LocalTokenizer {
    tokenizer: Arc<HfTokenizer>,
    permits: Arc<Semaphore>,
    vocab_count: usize,
    bos: Option<u32>,
}

#[derive(Deserialize)]
struct Artifact {
    version:String,
    truncation:Option<serde_json::Value>,
    padding:Option<serde_json::Value>,
    normalizer:Option<tokenizers::normalizers::NormalizerWrapper>,
    pre_tokenizer:Option<tokenizers::pre_tokenizers::PreTokenizerWrapper>,
    post_processor:Option<tokenizers::processors::PostProcessorWrapper>,
    decoder:Option<tokenizers::decoders::DecoderWrapper>,
    added_tokens:Vec<ArtifactToken>,
    model:ArtifactBpe,
}
#[derive(Deserialize)]
struct ArtifactToken {id:u32,content:String,single_word:bool,lstrip:bool,rstrip:bool,normalized:bool,special:bool}
#[derive(Deserialize)]
struct ArtifactBpe {
    #[serde(rename="type")] kind:String,
    dropout:Option<f32>,unk_token:Option<String>,continuing_subword_prefix:Option<String>,end_of_word_suffix:Option<String>,
    fuse_unk:bool,byte_fallback:bool,ignore_merges:bool,vocab:HashMap<String,u32>,merges:Vec<(String,String)>,
}

impl LocalTokenizer {
    /// Production entry point: only the independently reviewed selected mapping.
    pub fn load_selected(directory: &Path, expected_model_sha256: &str) -> Result<Self, BackendError> {
        Self::load_inner(directory, expected_model_sha256, true)
    }
    /// General loader for isolated synthetic fixtures, never used by main.
    pub fn load(directory: &Path, expected_model_sha256: &str) -> Result<Self, BackendError> {
        Self::load_inner(directory, expected_model_sha256, false)
    }
    fn load_inner(directory: &Path, expected_model_sha256: &str, selected: bool) -> Result<Self, BackendError> {
        let invalid = || BackendError::new(503, "The Rust tokenizer artifact is invalid.");
        let manifest_path = directory.join("manifest.json");
        if std::fs::metadata(&manifest_path).map_err(|_| invalid())?.len() > 4096 { return Err(invalid()); }
        let manifest: TokenizerManifest = serde_json::from_slice(&std::fs::read(manifest_path).map_err(|_| invalid())?).map_err(|_| invalid())?;
        if manifest.schema != 1 || manifest.model_sha256 != expected_model_sha256 || expected_model_sha256.len()!=64
            || manifest.pre != "qwen35" || manifest.vocab_count == 0 || manifest.vocab_count > 1_000_000
            || manifest.merge_count > 1_000_000 || manifest.add_bos && manifest.bos_token_id.is_none() { return Err(invalid()); }
        if selected && (expected_model_sha256 != SELECTED_MODEL_SHA256
            || manifest.tokenizer_sha256 != SELECTED_TOKENIZER_SHA256
            || manifest.vocab_count != 248_320 || manifest.merge_count != 247_587
            || manifest.add_bos || manifest.bos_token_id.is_some()) { return Err(invalid()); }
        let path = directory.join("tokenizer.json");
        if std::fs::metadata(&path).map_err(|_| invalid())?.len() > MAX_ARTIFACT_BYTES { return Err(invalid()); }
        let mut file=std::fs::File::open(path).map_err(|_|invalid())?;
        let mut hash=Sha256::new();let mut buffer=[0u8;65_536];let mut read_bytes=0u64;
        loop {
            let count=file.read(&mut buffer).map_err(|_|invalid())?;
            if count==0 {break;}
            read_bytes+=count as u64;if read_bytes>MAX_ARTIFACT_BYTES {return Err(invalid());}
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != manifest.tokenizer_sha256 { return Err(invalid()); }
        file.seek(SeekFrom::Start(0)).map_err(|_|invalid())?;
        // Stream the large vocabulary instead of retaining another JSON-sized
        // text allocation alongside the model's dictionaries during startup.
        let artifact:Artifact=serde_json::from_reader(std::io::BufReader::new(file)).map_err(|_|invalid())?;
        let model=artifact.model;
        if artifact.version!="1.0" || artifact.truncation.is_some() || artifact.padding.is_some()
            || model.kind!="BPE" || model.dropout.is_some() || model.unk_token.is_some()
            || model.continuing_subword_prefix.is_some() || model.end_of_word_suffix.is_some()
            || model.fuse_unk || model.byte_fallback || model.ignore_merges
            || model.vocab.len()!=manifest.vocab_count || model.merges.len()!=manifest.merge_count {return Err(invalid());}
        let vocab:Vocab=model.vocab.into_iter().collect();
        // Configure cache_capacity at construction. No mutable-model escape or
        // C++ tokenizer is needed, and no input-derived word cache is created.
        let bpe=BPE::builder().vocab_and_merges(vocab,model.merges).cache_capacity(0).build().map_err(|_|invalid())?;
        let mut tokenizer=HfTokenizer::new(bpe);
        tokenizer.with_normalizer(artifact.normalizer).with_pre_tokenizer(artifact.pre_tokenizer)
            .with_post_processor(artifact.post_processor).with_decoder(artifact.decoder);
        for added in artifact.added_tokens {
            if tokenizer.token_to_id(&added.content)!=Some(added.id) {return Err(invalid());}
            let token=AddedToken::from(added.content,added.special).single_word(added.single_word)
                .lstrip(added.lstrip).rstrip(added.rstrip).normalized(added.normalized);
            tokenizer.add_tokens(&[token]);
        }
        if tokenizer.get_vocab_size(true)!=manifest.vocab_count {return Err(invalid());}
        let bos = if manifest.add_bos { manifest.bos_token_id } else { None };
        if bos.is_some_and(|id| id as usize >= manifest.vocab_count) {return Err(invalid());}
        Ok(Self { tokenizer: Arc::new(tokenizer), permits: Arc::new(Semaphore::new(1)), vocab_count: manifest.vocab_count, bos })
    }
}

#[async_trait]
impl Tokenizer for LocalTokenizer {
    async fn ready(&self) -> bool { true }
    async fn encode(&self, prompt: &str, cancel: &CancellationToken) -> Result<Vec<u32>, BackendError> {
        let cancelled = || BackendError::new(499, "Request cancelled.");
        if cancel.is_cancelled() {return Err(cancelled());}
        if prompt.len() > MAX_PROMPT_BYTES {return Err(BackendError::new(413, "This model prompt is too large."));}
        let permit = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled()),
            result = self.permits.clone().acquire_owned() => result.map_err(|_| BackendError::new(503, "The Rust tokenizer is unavailable."))?,
        };
        if cancel.is_cancelled() {return Err(cancelled());}
        let text = prompt.to_owned();
        let tokenizer = self.tokenizer.clone();
        let bos = self.bos;
        // Retain the permit and owned input until this bounded CPU operation has
        // actually ended. Abandoning spawn_blocking on Stop would retain a prompt
        // after request cleanup and allow unbounded queued encodes.
        let tokens = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let encoded = tokenizer.encode(text, false).map_err(|_| BackendError::new(502, "Rust tokenization failed."))?;
            let mut ids = Vec::with_capacity(encoded.len()+usize::from(bos.is_some()));
            if let Some(id) = bos {ids.push(id);}
            ids.extend_from_slice(encoded.get_ids());
            Ok::<_,BackendError>(ids)
        }).await.map_err(|_| BackendError::new(503, "The Rust tokenizer stopped unexpectedly."))??;
        if cancel.is_cancelled() {return Err(cancelled());}
        if tokens.iter().any(|id| *id as usize >= self.vocab_count) {return Err(BackendError::new(502, "The Rust tokenizer returned invalid IDs."));}
        Ok(tokens)
    }
}
