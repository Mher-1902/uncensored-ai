use offscript_backend::supervisor::{check_memory, check_temperatures, command_arguments, parse_memory, read_model_config, read_temperatures, verify_file, verify_private_directory, MemorySnapshot, ModelConfig};
use std::{fs, os::unix::fs::{symlink, MetadataExt, PermissionsExt}, path::{Path, PathBuf}};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("offscript-supervisor-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap(); Self(path)
    }
    fn join(&self, value: &str) -> PathBuf {self.0.join(value)}
}
impl Drop for Fixture {fn drop(&mut self) {let _ = fs::remove_dir_all(&self.0);}}

fn profile() -> serde_json::Value {
    serde_json::json!({"filename":"model.gguf","bytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","context":4096,"threads":2,"minimumAvailableMiB":2150,"minimumTotalMiB":3500,"template":{"filename":"qwen35.jinja","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}})
}
fn config() -> ModelConfig {serde_json::from_value(profile()).unwrap()}

#[test]
fn memory_checks_use_available_physical_ram_and_never_add_swap() {
    let memory = parse_memory("MemTotal: 4096000 kB\nMemAvailable: 2201600 kB\nSwapTotal: 999999999 kB\nSwapFree: 0 kB\n").unwrap();
    assert_eq!(memory, MemorySnapshot{total_mib:4000, available_mib:2150});
    check_memory(memory,&config()).unwrap();
    assert!(check_memory(MemorySnapshot{total_mib:8000,available_mib:2149},&config()).is_err());
    assert!(check_memory(MemorySnapshot{total_mib:3499,available_mib:3000},&config()).is_err());
    assert!(parse_memory("MemTotal: 1024 kB\nMemAvailable: 2048 kB\n").is_err());
    assert!(parse_memory("MemTotal: 4096000 kB\n").is_err());
    assert!(parse_memory("MemTotal: 4096000 bytes\nMemAvailable: 2201600 kB\n").is_err());
}

#[test]
fn artifacts_require_exact_length_digest_and_regular_files() {
    let fixture=Fixture::new(); let model=fixture.join("model.gguf"); fs::write(&model,b"abc").unwrap();
    let digest=&config().sha256;
    verify_file(&model,Some(3),digest).unwrap();
    assert!(verify_file(&model,Some(4),digest).is_err());
    fs::write(&model,b"abd").unwrap(); assert!(verify_file(&model,Some(3),digest).is_err());
    let link=fixture.join("link");symlink(&model,&link).unwrap();assert!(verify_file(&link,Some(3),digest).is_err());
    assert!(verify_file(&fixture.0,None,digest).is_err());
}

#[test]
fn profile_cannot_escape_artifact_directories_or_request_invalid_limits() {
    let fixture=Fixture::new();let path=fixture.join("model.json");fs::write(&path,profile().to_string()).unwrap();
    assert_eq!(read_model_config(&path).unwrap().context,4096);
    for (key,value) in [("filename",serde_json::json!("../model.gguf")),("threads",serde_json::json!(0)),("context",serde_json::json!(0)),("sha256",serde_json::json!("bad"))] {
        let mut profile=profile();profile[key]=value;fs::write(&path,profile.to_string()).unwrap();assert!(read_model_config(&path).is_err());
    }
    let mut profile=profile();profile["template"]["filename"]=serde_json::json!("/tmp/template");fs::write(&path,profile.to_string()).unwrap();assert!(read_model_config(&path).is_err());
}

#[test]
fn temperature_safety_requires_valid_sensors_and_stops_at_limit() {
    let fixture=Fixture::new();let hw=fixture.join("hwmon0");fs::create_dir(&hw).unwrap();
    assert!(read_temperatures(&fixture.0).is_err());fs::write(hw.join("name"),"coretemp\n").unwrap();
    fs::write(hw.join("temp1_input"),"84999\n").unwrap();fs::write(hw.join("temp2_input"),"70000\n").unwrap();
    let readings=read_temperatures(&fixture.0).unwrap();check_temperatures(&readings,85000).unwrap();assert!(check_temperatures(&readings,80000).is_err());
    fs::write(hw.join("temp2_input"),"85000\n").unwrap();assert!(check_temperatures(&read_temperatures(&fixture.0).unwrap(),85000).is_err());
    fs::write(hw.join("temp2_input"),"not a reading\n").unwrap();assert!(read_temperatures(&fixture.0).is_err());
    assert!(check_temperatures(&[],85000).is_err());
}

#[test]
fn private_runtime_rejects_wide_permissions_wrong_owner_and_symlinks() {
    let fixture=Fixture::new();let uid=fs::metadata(&fixture.0).unwrap().uid();verify_private_directory(&fixture.0,uid).unwrap();
    assert!(verify_private_directory(&fixture.0,uid.wrapping_add(1)).is_err());
    fs::set_permissions(&fixture.0,fs::Permissions::from_mode(0o755)).unwrap();assert!(verify_private_directory(&fixture.0,uid).is_err());
    fs::set_permissions(&fixture.0,fs::Permissions::from_mode(0o700)).unwrap();
    let linked=fixture.join("linked");symlink(&fixture.0,&linked).unwrap();assert!(verify_private_directory(&linked,uid).is_err());
    assert!(verify_private_directory(Path::new("relative"),uid).is_err());
}

#[test]
fn child_arguments_preserve_cpu_profile_privacy_and_single_slot() {
    let args=command_arguments(Path::new("/models/model.gguf"),Path::new("/app/self-host/qwen35.jinja"),Path::new("/run/model/offscript-model"),&config());
    let strings:Vec<_>=args.iter().map(|s|s.to_string_lossy().into_owned()).collect();
    let following=|flag:&str|strings[strings.iter().position(|s|s==flag).unwrap()+1].clone();
    for (key,value) in [("--host","127.0.0.1"),("--port","8081"),("--ctx-size","4096"),("--parallel","1"),("--threads","2"),("--threads-batch","2"),("--n-gpu-layers","0"),("--cache-ram","0"),("--slot-save-path","/run/model/offscript-model")] {assert_eq!(following(key),value);}
    for flag in ["--no-cache-idle-slots","--no-context-shift","--jinja","--slots","--no-webui","--log-disable"] {assert!(strings.iter().any(|s|s==flag));}
    assert!(!strings.iter().any(|s|s=="--mlock"||s=="--log-file"));
}
