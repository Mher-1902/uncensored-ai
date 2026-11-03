use std::path::PathBuf;

use offscript_backend::retrieval::{EncoderIdentity, ReferenceIndex, SearchOptions, TrustedArtifacts, DIMENSION};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn encoder() -> EncoderIdentity {
    EncoderIdentity { model_id: "sentence-transformers/all-MiniLM-L6-v2".into(), revision: "a".repeat(40),
        weights_sha256: "1".repeat(64), tokenizer_sha256: "2".repeat(64), config_sha256: "3".repeat(64),
        dimension: 384, max_sequence_length: 256, pooling: "attention_masked_mean".into(), normalization: "l2".into(), dtype: "f32".into() }
}
fn vector(first: f32, second: f32) -> Vec<f32> {
    let mut values = vec![0.0; DIMENSION]; values[0] = first; values[1] = second; values
}
fn passage(id: &str, text: &str, vector: Vec<f32>) -> Value {
    json!({"id": id, "title": "Public reference", "source_url": "https://docs.example.org/reference#section",
        "text": text, "text_sha256": hash(text.as_bytes()), "embedding": vector})
}
struct Fixture { root: PathBuf, manifest: Value, pins: TrustedArtifacts }
impl Fixture {
    fn new(passages: &[Value]) -> Self {
        let root = std::env::temp_dir().join(format!("offscript-retrieval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let identity = encoder();
        let manifest = json!({"schema": 1, "format": "offscript-public-references-jsonl-v1", "scope": "public",
            "corpus_version": "references-20261102-1", "corpus_sha256": "", "passage_count": 0, "encoder": identity});
        let pins = TrustedArtifacts { manifest_sha256: String::new(), encoder_fingerprint: identity.fingerprint().unwrap(),
            corpus_version: "references-20261102-1".into(), allowed_origins: vec!["https://docs.example.org".into()] };
        let mut fixture = Self { root, manifest, pins };
        fixture.publish(passages);
        fixture
    }
    fn publish(&mut self, passages: &[Value]) {
        let mut bytes = Vec::new();
        for passage in passages { serde_json::to_writer(&mut bytes, passage).unwrap(); bytes.push(b'\n'); }
        self.publish_raw(&bytes, passages.len());
    }
    fn publish_raw(&mut self, bytes: &[u8], count: usize) {
        std::fs::write(self.root.join("passages.jsonl"), bytes).unwrap();
        self.manifest["corpus_sha256"] = json!(hash(bytes)); self.manifest["passage_count"] = json!(count);
        self.repin_manifest();
    }
    fn repin_manifest(&mut self) {
        let bytes = serde_json::to_vec(&self.manifest).unwrap();
        self.pins.manifest_sha256 = hash(&bytes);
        std::fs::write(self.root.join("manifest.json"), bytes).unwrap();
    }
    fn load(&self) -> ReferenceIndex { ReferenceIndex::load(&self.root, &self.pins).unwrap() }
    fn rejected(&self) { assert!(ReferenceIndex::load(&self.root, &self.pins).is_err()); }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

#[test]
fn cosine_order_threshold_and_stable_citation_bytes() {
    let fixture = Fixture::new(&[
        passage("orthogonal", "Unrelated public text", vector(0.0, 1.0)),
        passage("opposite", "Other public text", vector(-1.0, 0.0)),
        passage("exact", "Relevant public text", vector(1.0, 0.0)),
    ]);
    let index = fixture.load();
    assert_eq!(index.len(), 3); assert!(!index.is_empty());
    let options = SearchOptions { top_k: 8, min_cosine: -1.0, semantic_weight: 1.0 };
    let results = index.search("question", &vector(1.0, 0.0), index.encoder_fingerprint(), options).unwrap();
    assert_eq!(results.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["exact", "orthogonal", "opposite"]);
    assert_eq!(results[0].cosine, 1.0); assert_eq!(results[1].cosine, 0.0); assert_eq!(results[2].cosine, -1.0);
    assert_eq!(results[0].text_sha256, hash(results[0].text.as_bytes()));
    assert_eq!(results[0].source_url, "https://docs.example.org/reference#section");
    assert_eq!(results[0].corpus_version, index.corpus_version());
    let exact_only = index.search("question", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions { min_cosine: 1.0, ..options }).unwrap();
    assert_eq!(exact_only.len(), 1);
    let no_hits = index.search("question", &vector(0.0, -1.0), index.encoder_fingerprint(), SearchOptions::default()).unwrap();
    assert!(no_hits.is_empty());
}

#[test]
fn lexical_coverage_can_rerank_without_frequency_inflation() {
    let fixture = Fixture::new(&[
        passage("semantic", "Other concepts", vector(0.9, 0.4358899)),
        passage("both", "Rust rust rust tokenizer", vector(0.8, 0.6)),
        passage("one", "Rust rust rust rust rust rust", vector(0.8, 0.6)),
    ]);
    let index = fixture.load();
    let results = index.search("RUST tokenizer", &vector(1.0, 0.0), index.encoder_fingerprint(),
        SearchOptions { top_k: 3, min_cosine: 0.0, semantic_weight: 0.6 }).unwrap();
    assert_eq!(results[0].id, "both"); assert_eq!(results[0].lexical_coverage, 1.0);
    assert_eq!(results[1].id, "one"); assert_eq!(results[1].lexical_coverage, 0.5);
    assert_eq!(results[2].id, "semantic"); assert_eq!(results[2].lexical_coverage, 0.0);
}

#[test]
fn ties_are_order_independent_and_top_k_is_bounded() {
    let fixture = Fixture::new(&[
        passage("zeta", "Same words", vector(1.0, 0.0)), passage("alpha", "Same words", vector(1.0, 0.0)),
    ]);
    let index = fixture.load();
    let results = index.search("same words", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions { top_k: 1, ..SearchOptions::default() }).unwrap();
    assert_eq!(results.len(), 1); assert_eq!(results[0].id, "alpha");
    for bad in [0, 9, usize::MAX] {
        assert!(index.search("same", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions { top_k: bad, ..SearchOptions::default() }).is_err());
    }
}

#[test]
fn manifest_encoder_and_corpus_versions_are_independently_pinned() {
    let mut fixture = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]);
    fixture.pins.manifest_sha256 = "0".repeat(64); fixture.rejected(); fixture.repin_manifest();
    fixture.pins.encoder_fingerprint = "0".repeat(64); fixture.rejected(); fixture.pins.encoder_fingerprint = encoder().fingerprint().unwrap();
    fixture.pins.corpus_version = "different".into(); fixture.rejected(); fixture.pins.corpus_version = "references-20261102-1".into();
    fixture.manifest["encoder"]["weights_sha256"] = json!("4".repeat(64)); fixture.repin_manifest(); fixture.rejected();
    fixture.manifest["encoder"] = serde_json::to_value(encoder()).unwrap();
    fixture.manifest["scope"] = json!("private"); fixture.repin_manifest(); fixture.rejected();
    fixture.manifest["scope"] = json!("public"); fixture.manifest["passage_count"] = json!(10_001); fixture.repin_manifest(); fixture.rejected();
}

#[test]
fn corpus_and_passage_hashes_both_detect_tampering() {
    let mut item = passage("one", "Public text", vector(1.0, 0.0));
    let mut fixture = Fixture::new(&[item.clone()]);
    std::fs::write(fixture.root.join("passages.jsonl"), b"{}\n").unwrap(); fixture.rejected();
    item["text"] = json!("Changed text with the old text hash"); fixture.publish(&[item]); fixture.rejected();
    fixture.manifest["unknown"] = json!(true); fixture.repin_manifest(); fixture.rejected();
}

#[test]
fn zero_non_normalized_wrong_dimension_and_nonfinite_vectors_are_rejected() {
    for bad in [vec![0.0; DIMENSION], vector(2.0, 0.0), vec![1.0; DIMENSION - 1]] {
        let fixture = Fixture::new(&[passage("one", "Public text", bad)]); fixture.rejected();
    }
    let mut fixture = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]);
    let bytes = std::fs::read_to_string(fixture.root.join("passages.jsonl")).unwrap().replacen("1.0", "1e9999", 1);
    fixture.publish_raw(bytes.as_bytes(), 1); fixture.rejected();
    let valid = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]); let index = valid.load();
    for first in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, 2.0] {
        assert!(index.search("query", &vector(first, 0.0), index.encoder_fingerprint(), SearchOptions::default()).is_err());
    }
    assert!(index.search("query", &[1.0], index.encoder_fingerprint(), SearchOptions::default()).is_err());
}

#[test]
fn only_allowlisted_public_https_citations_are_accepted() {
    for source in ["http://docs.example.org/a", "https://evil.example.org/a", "https://docs.example.org.evil.test/a",
        "https://user:password@docs.example.org/a", "https://docs.example.org:8443/a", "https://127.0.0.1/a",
        "https://[::1]/a", "https://docs.example.org/a\r\nInjected:value", "file:///tmp/private", "javascript:alert(1)"] {
        let mut item = passage("one", "Public text", vector(1.0, 0.0)); item["source_url"] = json!(source);
        Fixture::new(&[item]).rejected();
    }
    for origin in ["https://127.0.0.1", "https://service.local", "https://docs.example.org/path", "https://docs.example.org?query=1", "https://docs.example.org/"] {
        let mut fixture = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]); fixture.pins.allowed_origins = vec![origin.into()]; fixture.rejected();
    }
}

#[test]
fn text_metadata_lines_duplicates_and_trailing_data_are_bounded() {
    let item = passage("one", "Public text", vector(1.0, 0.0));
    Fixture::new(&[item.clone(), item.clone()]).rejected();
    for (field, value) in [("text", "x".repeat(4097)), ("title", "x".repeat(257)), ("id", "x".repeat(97)),
        ("title", "Header\nInjected".into()), ("text", "private\u{0}bytes".into()), ("id", "../path".into())] {
        let mut bad = item.clone(); bad[field] = json!(value); if field == "text" { bad["text_sha256"] = json!(hash(value.as_bytes())); }
        Fixture::new(&[bad]).rejected();
    }
    let mut fixture = Fixture::new(&[item]);
    fixture.publish_raw(&vec![b' '; 32_769], 1); fixture.rejected();
    fixture.publish_raw(b"{}", 1); fixture.rejected();
    fixture.publish_raw(b"\n", 1); fixture.rejected();
    fixture.publish_raw(b"{}\r\n", 1); fixture.rejected();
    fixture.publish_raw(b"{}\n{}\n", 1); fixture.rejected();
}

#[test]
fn search_inputs_encoder_mismatch_and_nonfinite_options_fail_without_mutation() {
    let fixture = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]); let index = fixture.load();
    for text in [String::new(), "  ".into(), "x".repeat(2049), "x".repeat(129), "input\u{0}".into(),
        (0..65).map(|n| format!("term{n}")).collect::<Vec<_>>().join(" ")] {
        assert!(index.search(&text, &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions::default()).is_err());
    }
    assert!(index.search("query", &vector(1.0, 0.0), &"0".repeat(64), SearchOptions::default()).is_err());
    for min in [f64::NAN, f64::INFINITY, -1.1, 1.1] {
        assert!(index.search("query", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions { min_cosine: min, ..SearchOptions::default() }).is_err());
    }
    for weight in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
        assert!(index.search("query", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions { semantic_weight: weight, ..SearchOptions::default() }).is_err());
    }
    assert_eq!(index.len(), 1);
    assert_eq!(index.search("public", &vector(1.0, 0.0), index.encoder_fingerprint(), SearchOptions::default()).unwrap()[0].id, "one");
}

#[test]
fn encoder_contract_rejects_unreviewed_pooling_dimensions_or_configuration() {
    let baseline = encoder();
    assert_eq!(baseline.fingerprint().unwrap().len(), 64);
    let mut different = baseline.clone(); different.tokenizer_sha256 = "5".repeat(64);
    assert_ne!(baseline.fingerprint().unwrap(), different.fingerprint().unwrap());
    for field in ["dimension", "max_sequence_length", "pooling", "normalization", "dtype", "model_id", "revision"] {
        let mut value = serde_json::to_value(&baseline).unwrap();
        value[field] = if ["dimension", "max_sequence_length"].contains(&field) { json!(512) } else { json!("wrong") };
        let identity: EncoderIdentity = serde_json::from_value(value).unwrap(); assert!(identity.fingerprint().is_err());
    }
}

#[cfg(unix)]
#[test]
fn artifact_symlinks_are_not_followed() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(&[passage("one", "Public text", vector(1.0, 0.0))]);
    std::fs::rename(fixture.root.join("passages.jsonl"), fixture.root.join("elsewhere.jsonl")).unwrap();
    symlink("elsewhere.jsonl", fixture.root.join("passages.jsonl")).unwrap(); fixture.rejected();
}
