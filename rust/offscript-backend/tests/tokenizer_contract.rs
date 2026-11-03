use std::{fs, path::PathBuf};
use offscript_backend::tokenizer::{LocalTokenizer, Tokenizer};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tokio_util::sync::CancellationToken;

const MODEL: &str = "1111111111111111111111111111111111111111111111111111111111111111";
struct Fixture(PathBuf);
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn make_fixture(bos:bool)->Fixture {
    let path=std::env::temp_dir().join(format!("offscript-tokenizer-{}",uuid::Uuid::new_v4()));fs::create_dir(&path).unwrap();
    let artifact=json!({"version":"1.0","truncation":null,"padding":null,"normalizer":null,"pre_tokenizer":null,"post_processor":null,"decoder":null,
      "added_tokens":[{"id":3,"content":"<special>","single_word":false,"lstrip":false,"rstrip":false,"normalized":false,"special":true}],
      "model":{"type":"BPE","dropout":null,"unk_token":null,"continuing_subword_prefix":null,"end_of_word_suffix":null,"fuse_unk":false,"byte_fallback":false,"ignore_merges":false,"vocab":{"a":0,"b":1,"ab":2,"<special>":3},"merges":[["a","b"]]}});
    let bytes=serde_json::to_vec(&artifact).unwrap();
    let manifest=json!({"schema":1,"model_sha256":MODEL,"tokenizer_sha256":format!("{:x}",Sha256::digest(&bytes)),"vocab_count":4,"merge_count":1,"pre":"qwen35","add_bos":bos,"bos_token_id":if bos{Some(3)}else{None}});
    fs::write(path.join("tokenizer.json"),bytes).unwrap();fs::write(path.join("manifest.json"),serde_json::to_vec(&manifest).unwrap()).unwrap();Fixture(path)
}
#[tokio::test]
async fn performs_real_rust_bpe_and_preserves_special_ids_without_cpp() {
    let fixture=make_fixture(false);let tokenizer=LocalTokenizer::load(&fixture.0,MODEL).unwrap();let cancel=CancellationToken::new();
    assert_eq!(tokenizer.encode("ab",&cancel).await.unwrap(),vec![2]);
    assert_eq!(tokenizer.encode("<special>ab",&cancel).await.unwrap(),vec![3,2]);
    assert!(tokenizer.ready().await);
}
#[tokio::test]
async fn adds_only_manifest_requested_bos_and_rejects_cancelled_or_oversized_input() {
    let fixture=make_fixture(true);let tokenizer=LocalTokenizer::load(&fixture.0,MODEL).unwrap();let cancel=CancellationToken::new();
    assert_eq!(tokenizer.encode("ab",&cancel).await.unwrap(),vec![3,2]);
    assert_eq!(tokenizer.encode(&"a".repeat(131073),&cancel).await.unwrap_err().status,413);
    cancel.cancel();assert_eq!(tokenizer.encode("ab",&cancel).await.unwrap_err().status,499);
}
#[test]
fn wrong_model_corrupt_artifact_and_manifest_tampering_fail_closed() {
    let fixture=make_fixture(false);
    assert!(LocalTokenizer::load(&fixture.0,&"2".repeat(64)).is_err());
    fs::write(fixture.0.join("tokenizer.json"),b"{}").unwrap();
    assert!(LocalTokenizer::load(&fixture.0,MODEL).is_err());
    let fixture=make_fixture(false);let path=fixture.0.join("manifest.json");let mut manifest:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["vocab_count"]=json!(5);fs::write(path,serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(LocalTokenizer::load(&fixture.0,MODEL).is_err());
}

#[test]
fn a_self_declared_model_checksum_cannot_select_a_different_production_tokenizer() {
    let fixture=make_fixture(false);
    assert!(LocalTokenizer::load(&fixture.0,MODEL).is_ok());
    assert!(LocalTokenizer::load_selected(&fixture.0,MODEL).is_err());
    let selected="be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517";
    let path=fixture.0.join("manifest.json");
    let mut manifest:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["model_sha256"]=json!(selected);
    fs::write(path,serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(LocalTokenizer::load(&fixture.0,selected).is_ok());
    assert!(LocalTokenizer::load_selected(&fixture.0,selected).is_err());
}
