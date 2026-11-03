//! Bounded ranking over a verified PUBLIC reference artifact.
//!
//! This module does not compute embeddings, fetch documents or store queries.
//! A separately verified encoder must supply a matching query embedding.
use std::{collections::HashSet, fs::File, io::{BufRead, BufReader, Read}, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::BackendError;

pub const DIMENSION: usize = 384;
pub const MAX_PASSAGES: usize = 10_000;
pub const MAX_QUERY_BYTES: usize = 2048;
const MAX_MANIFEST_BYTES: u64 = 16_384;
const MAX_CORPUS_BYTES: u64 = 100_663_296;
const MAX_LINE_BYTES: usize = 32_768;
const MAX_TEXT_BYTES: usize = 4096;
const MAX_METADATA_AND_TEXT_BYTES: usize = 16_777_216;
const MAX_QUERY_TERMS: usize = 64;
const MAX_TERM_BYTES: usize = 128;
const NORMALIZATION_TOLERANCE: f64 = 0.002;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EncoderIdentity {
    pub model_id: String,
    pub revision: String,
    pub weights_sha256: String,
    pub tokenizer_sha256: String,
    pub config_sha256: String,
    pub dimension: usize,
    pub max_sequence_length: usize,
    pub pooling: String,
    pub normalization: String,
    pub dtype: String,
}

impl EncoderIdentity {
    /// The caller pins this fingerprint independently of the corpus manifest.
    /// It identifies encoder configuration, not proof that inference occurred.
    pub fn fingerprint(&self) -> Result<String, BackendError> {
        if self.model_id != "sentence-transformers/all-MiniLM-L6-v2"
            || !lower_hex(&self.revision, 40)
            || !lower_hex(&self.weights_sha256, 64)
            || !lower_hex(&self.tokenizer_sha256, 64)
            || !lower_hex(&self.config_sha256, 64)
            || self.dimension != DIMENSION || self.max_sequence_length != 256
            || self.pooling != "attention_masked_mean" || self.normalization != "l2" || self.dtype != "f32" {
            return Err(invalid_artifact());
        }
        // Length-prefixed fields prevent concatenation ambiguity. Do not hash
        // serializer-specific field ordering as an implicit artifact format.
        let mut hash = Sha256::new();
        for part in ["offscript-encoder-v1", &self.model_id, &self.revision, &self.weights_sha256,
            &self.tokenizer_sha256, &self.config_sha256, "384", "256", &self.pooling, &self.normalization, &self.dtype] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        Ok(format!("{:x}", hash.finalize()))
    }
}

/// Pins come from the reviewed deployment configuration, not the artifact
/// directory or an end-user request. A self-reported checksum is insufficient.
pub struct TrustedArtifacts {
    pub manifest_sha256: String,
    pub encoder_fingerprint: String,
    pub corpus_version: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    format: String,
    scope: String,
    corpus_version: String,
    corpus_sha256: String,
    passage_count: usize,
    encoder: EncoderIdentity,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactPassage {
    id: String,
    title: String,
    source_url: String,
    text: String,
    text_sha256: String,
    embedding: Vec<f32>,
}

struct Passage {
    id: String,
    title: String,
    source_url: String,
    text: String,
    text_sha256: String,
    embedding: Box<[f32]>,
    norm: f64,
}

pub struct ReferenceIndex {
    encoder_fingerprint: String,
    corpus_version: String,
    passages: Vec<Passage>,
}

#[derive(Clone, Copy)]
pub struct SearchOptions {
    pub top_k: usize,
    pub min_cosine: f64,
    pub semantic_weight: f64,
}
impl Default for SearchOptions {
    fn default() -> Self { Self { top_k: 4, min_cosine: 0.25, semantic_weight: 0.8 } }
}

#[derive(Clone, Debug, Serialize)]
pub struct RetrievedPassage {
    pub id: String,
    pub title: String,
    pub source_url: String,
    pub text: String,
    pub text_sha256: String,
    pub corpus_version: String,
    pub encoder_fingerprint: String,
    pub cosine: f64,
    pub lexical_coverage: f64,
    pub score: f64,
}

impl ReferenceIndex {
    /// Reads fixed filenames only. The directory must be an owner-controlled,
    /// immutable, read-only artifact mount. No network or content logging occurs.
    pub fn load(directory: &Path, pins: &TrustedArtifacts) -> Result<Self, BackendError> {
        if !lower_hex(&pins.manifest_sha256, 64) || !lower_hex(&pins.encoder_fingerprint, 64)
            || !identifier(&pins.corpus_version, 64) || pins.allowed_origins.is_empty() || pins.allowed_origins.len() > 16 {
            return Err(invalid_artifact());
        }
        let directory_meta = std::fs::symlink_metadata(directory).map_err(|_| invalid_artifact())?;
        if !directory_meta.is_dir() || directory_meta.file_type().is_symlink() { return Err(invalid_artifact()); }
        let mut origins = HashSet::new();
        for origin in &pins.allowed_origins {
            if origin.len() > 256 { return Err(invalid_artifact()); }
            let parsed = public_url(origin)?;
            let canonical = parsed.origin().ascii_serialization();
            if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() || origin != &canonical
                || !origins.insert(canonical) { return Err(invalid_artifact()); }
        }
        let mut manifest_file = regular_file(&directory.join("manifest.json"), MAX_MANIFEST_BYTES)?;
        let mut bytes = Vec::new();
        (&mut manifest_file).take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes).map_err(|_| invalid_artifact())?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES || sha256(&bytes) != pins.manifest_sha256 { return Err(invalid_artifact()); }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid_artifact())?;
        let fingerprint = manifest.encoder.fingerprint()?;
        if manifest.schema != 1 || manifest.format != "offscript-public-references-jsonl-v1" || manifest.scope != "public"
            || manifest.corpus_version != pins.corpus_version || !lower_hex(&manifest.corpus_sha256, 64)
            || fingerprint != pins.encoder_fingerprint || manifest.passage_count == 0 || manifest.passage_count > MAX_PASSAGES {
            return Err(invalid_artifact());
        }
        let file = regular_file(&directory.join("passages.jsonl"), MAX_CORPUS_BYTES)?;
        let mut reader = BufReader::with_capacity(16_384, file);
        let mut line = Vec::new();
        let mut total = 0u64;
        let mut text_bytes = fingerprint.len() + manifest.corpus_version.len();
        let mut hash = Sha256::new();
        let mut ids = HashSet::new();
        let mut passages = Vec::with_capacity(manifest.passage_count);
        while bounded_line(&mut reader, &mut line)? {
            total = total.checked_add(line.len() as u64).ok_or_else(invalid_artifact)?;
            if total > MAX_CORPUS_BYTES || passages.len() >= manifest.passage_count { return Err(invalid_artifact()); }
            hash.update(&line);
            // Canonical JSONL has one nonempty JSON object per LF-terminated line.
            if line.last() != Some(&b'\n') || line.len() == 1 || line.get(line.len() - 2) == Some(&b'\r') { return Err(invalid_artifact()); }
            let artifact: ArtifactPassage = serde_json::from_slice(&line[..line.len() - 1]).map_err(|_| invalid_artifact())?;
            if !identifier(&artifact.id, 96) || !ids.insert(artifact.id.clone())
                || artifact.title.trim().is_empty() || artifact.title.len() > 256 || artifact.title.chars().any(label_control)
                || artifact.text.trim().is_empty() || artifact.text.len() > MAX_TEXT_BYTES
                || artifact.text.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
                || !lower_hex(&artifact.text_sha256, 64) || sha256(artifact.text.as_bytes()) != artifact.text_sha256 {
                return Err(invalid_artifact());
            }
            let source = public_url(&artifact.source_url)?;
            if !origins.contains(&source.origin().ascii_serialization()) { return Err(invalid_artifact()); }
            text_bytes = text_bytes.checked_add(artifact.text.len() + artifact.title.len() + artifact.source_url.len() + artifact.id.len() + artifact.text_sha256.len())
                .ok_or_else(invalid_artifact)?;
            if text_bytes > MAX_METADATA_AND_TEXT_BYTES { return Err(invalid_artifact()); }
            let norm = normalized_norm(&artifact.embedding).ok_or_else(invalid_artifact)?;
            passages.push(Passage { id: artifact.id, title: artifact.title, source_url: artifact.source_url, text: artifact.text,
                text_sha256: artifact.text_sha256, embedding: artifact.embedding.into_boxed_slice(), norm });
        }
        if passages.len() != manifest.passage_count || format!("{:x}", hash.finalize()) != manifest.corpus_sha256 { return Err(invalid_artifact()); }
        Ok(Self { encoder_fingerprint: fingerprint, corpus_version: manifest.corpus_version, passages })
    }

    pub fn len(&self) -> usize { self.passages.len() }
    pub fn is_empty(&self) -> bool { self.passages.is_empty() }
    pub fn encoder_fingerprint(&self) -> &str { &self.encoder_fingerprint }
    pub fn corpus_version(&self) -> &str { &self.corpus_version }

    /// The trusted encoder adapter supplies `embedding`, matching the pinned
    /// identity. A fingerprint supplied by a browser would not authenticate it.
    /// Query text/vector live only for this call and are never inserted in index.
    pub fn search(&self, query: &str, embedding: &[f32], encoder_fingerprint: &str, options: SearchOptions)
        -> Result<Vec<RetrievedPassage>, BackendError> {
        let invalid = || BackendError::new(400, "Invalid reference search input.");
        if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES
            || query.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
            || encoder_fingerprint != self.encoder_fingerprint
            || !(1..=8).contains(&options.top_k) || !options.min_cosine.is_finite() || !(-1.0..=1.0).contains(&options.min_cosine)
            || !options.semantic_weight.is_finite() || !(0.0..=1.0).contains(&options.semantic_weight) { return Err(invalid()); }
        let norm = normalized_norm(embedding).ok_or_else(invalid)?;
        let mut terms = HashSet::new();
        for term in lexical_tokens(query) {
            if term.len() > MAX_TERM_BYTES { return Err(invalid()); }
            terms.insert(term);
            if terms.len() > MAX_QUERY_TERMS { return Err(invalid()); }
        }
        let mut ranked = Vec::with_capacity(self.passages.len());
        for passage in &self.passages {
            let dot: f64 = embedding.iter().zip(passage.embedding.iter()).map(|(a, b)| f64::from(*a) * f64::from(*b)).sum();
            let cosine = (dot / (norm * passage.norm)).clamp(-1.0, 1.0);
            if cosine < options.min_cosine { continue; }
            // Count unique query-term coverage, not term frequency: repeating
            // one keyword in an artifact must not inflate its lexical score.
            let mut seen = HashSet::new();
            for term in lexical_tokens(&passage.title).chain(lexical_tokens(&passage.text)) {
                if terms.contains(&term) { seen.insert(term); }
            }
            let lexical = if terms.is_empty() { 0.0 } else { seen.len() as f64 / terms.len() as f64 };
            let score = options.semantic_weight * cosine.max(0.0) + (1.0 - options.semantic_weight) * lexical;
            ranked.push((passage, cosine, lexical, score));
        }
        ranked.sort_unstable_by(|a, b| b.3.total_cmp(&a.3).then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| b.2.total_cmp(&a.2)).then_with(|| a.0.id.cmp(&b.0.id)));
        Ok(ranked.into_iter().take(options.top_k).map(|(passage, cosine, lexical_coverage, score)| RetrievedPassage {
            id: passage.id.clone(), title: passage.title.clone(), source_url: passage.source_url.clone(), text: passage.text.clone(),
            text_sha256: passage.text_sha256.clone(), corpus_version: self.corpus_version.clone(), encoder_fingerprint: self.encoder_fingerprint.clone(),
            cosine, lexical_coverage, score,
        }).collect())
    }
}

fn invalid_artifact() -> BackendError { BackendError::new(503, "The public reference artifact is invalid.") }
fn sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-'))
}
fn label_control(ch: char) -> bool { ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') }
fn public_url(value: &str) -> Result<reqwest::Url, BackendError> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(|ch| ch.is_whitespace() || label_control(ch)) { return Err(invalid_artifact()); }
    let url = reqwest::Url::parse(value).map_err(|_| invalid_artifact())?;
    let host = url.host_str().ok_or_else(invalid_artifact)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || !host.contains('.') || host.ends_with('.') || host.ends_with(".localhost") || host.ends_with(".local")
        || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok() { return Err(invalid_artifact()); }
    Ok(url)
}
fn regular_file(path: &Path, max: u64) -> Result<File, BackendError> {
    let before = std::fs::symlink_metadata(path).map_err(|_| invalid_artifact())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > max { return Err(invalid_artifact()); }
    let file = File::open(path).map_err(|_| invalid_artifact())?;
    let after = file.metadata().map_err(|_| invalid_artifact())?;
    if !after.is_file() || after.len() > max { return Err(invalid_artifact()); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() { return Err(invalid_artifact()); }
    }
    Ok(file)
}
fn bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> Result<bool, BackendError> {
    line.clear();
    loop {
        let bytes = reader.fill_buf().map_err(|_| invalid_artifact())?;
        if bytes.is_empty() { return if line.is_empty() { Ok(false) } else { Err(invalid_artifact()) }; }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(bytes.len(), |position| position + 1);
        if line.len().saturating_add(count) > MAX_LINE_BYTES { return Err(invalid_artifact()); }
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if newline.is_some() { return Ok(true); }
    }
}
fn normalized_norm(vector: &[f32]) -> Option<f64> {
    if vector.len() != DIMENSION || vector.iter().any(|value| !value.is_finite()) { return None; }
    let squared: f64 = vector.iter().map(|value| f64::from(*value).powi(2)).sum();
    let norm = squared.sqrt();
    if !norm.is_finite() || norm <= 0.0 || (norm - 1.0).abs() > NORMALIZATION_TOLERANCE { None } else { Some(norm) }
}
fn lexical_tokens(value: &str) -> impl Iterator<Item = String> + '_ {
    value.split(|ch: char| !ch.is_alphanumeric()).filter(|word| !word.is_empty()).map(str::to_lowercase)
}
