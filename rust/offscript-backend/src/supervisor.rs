//! Single-child model supervision. This module never downloads weights, changes
//! host limits, restarts a failed child, or records conversation content.
use crate::BackendError;
use nix::{sys::signal::{kill, Signal}, unistd::Pid};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{ffi::OsString, fs::{self, File}, io::Read, os::unix::fs::{DirBuilderExt, MetadataExt}, path::{Component, Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{process::{Child, Command}, signal::unix::{signal, SignalKind}, time::{interval, timeout, MissedTickBehavior}};

const STARTUP_LIMIT_MILLICELSIUS: i64 = 80_000;
const RUNNING_LIMIT_MILLICELSIUS: i64 = 85_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub filename: String,
    pub bytes: u64,
    pub sha256: String,
    pub context: usize,
    pub threads: usize,
    #[serde(rename = "minimumAvailableMiB")]
    pub minimum_available_mib: u64,
    #[serde(rename = "minimumTotalMiB")]
    pub minimum_total_mib: u64,
    pub template: TemplateConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TemplateConfig {
    pub filename: String,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemorySnapshot {
    pub total_mib: u64,
    pub available_mib: u64,
}

fn failure(message: &'static str) -> BackendError { BackendError::new(503, message) }

fn filename_only(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

pub fn read_model_config(path: &Path) -> Result<ModelConfig, BackendError> {
    // The trusted deployment manifest is small; never allocate from an unbounded
    // file, and never accept path traversal from a profile field.
    let metadata = fs::symlink_metadata(path).map_err(|_| failure("The model profile is unavailable."))?;
    if !metadata.file_type().is_file() || metadata.len() > 65_536 {
        return Err(failure("The model profile is invalid."));
    }
    let config: ModelConfig = serde_json::from_slice(&fs::read(path).map_err(|_| failure("The model profile is unavailable."))?)
        .map_err(|_| failure("The model profile is invalid."))?;
    if !filename_only(&config.filename) || !filename_only(&config.template.filename)
        || !valid_digest(&config.sha256) || !valid_digest(&config.template.sha256)
        || config.bytes == 0 || config.context == 0 || config.context > 1_048_576
        || config.threads == 0 || config.threads > 256
        || config.minimum_available_mib == 0 || config.minimum_total_mib == 0 {
        return Err(failure("The model profile is invalid."));
    }
    Ok(config)
}

pub fn parse_memory(contents: &str) -> Result<MemorySnapshot, BackendError> {
    fn kib(contents: &str, field: &str) -> Option<u64> {
        let line = contents.lines().find(|line| line.split_once(':').map(|(key, _)| key == field).unwrap_or(false))?;
        let mut parts = line.split_once(':')?.1.split_whitespace();
        let value = parts.next()?.parse::<u64>().ok()?;
        if parts.next()? != "kB" || parts.next().is_some() { return None; }
        Some(value)
    }
    let total = kib(contents, "MemTotal").ok_or_else(|| failure("Memory readings are unavailable."))?;
    let available = kib(contents, "MemAvailable").ok_or_else(|| failure("Memory readings are unavailable."))?;
    if total == 0 || available > total { return Err(failure("Memory readings are invalid.")); }
    Ok(MemorySnapshot {total_mib: total / 1024, available_mib: available / 1024})
}

pub fn check_memory(memory: MemorySnapshot, config: &ModelConfig) -> Result<(), BackendError> {
    if memory.total_mib < config.minimum_total_mib || memory.available_mib < config.minimum_available_mib {
        return Err(failure("Not enough available RAM for this model profile. Swap is not counted as RAM."));
    }
    Ok(())
}

/// Collect only hwmon temperature inputs, as the existing supervisor does.
/// Missing or malformed files cannot be interpreted as a cool device.
pub fn read_temperatures(hwmon_root: &Path) -> Result<Vec<i64>, BackendError> {
    let mut result = Vec::new();
    let entries = fs::read_dir(hwmon_root).map_err(|_| failure("Thermal sensor readings are unavailable."))?;
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("hwmon") { continue; }
        if fs::read_to_string(entry.path().join("name")).is_err() { continue; }
        let Ok(sensors) = fs::read_dir(entry.path()) else { continue; };
        for sensor in sensors.flatten() {
            let name = sensor.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("temp") || !name.ends_with("_input") { continue; }
            let middle = &name[4..name.len() - 6];
            if middle.is_empty() || !middle.bytes().all(|b| b.is_ascii_digit()) { continue; }
            let value = fs::read_to_string(sensor.path()).map_err(|_| failure("Thermal sensor readings are unavailable."))?;
            let value = value.trim().parse::<i64>().map_err(|_| failure("Thermal sensor readings are invalid."))?;
            if value < -273_150 { return Err(failure("Thermal sensor readings are invalid.")); }
            result.push(value);
        }
    }
    if result.is_empty() { return Err(failure("Thermal sensors are required for this model profile.")); }
    Ok(result)
}

pub fn check_temperatures(values: &[i64], limit: i64) -> Result<(), BackendError> {
    if values.is_empty() { return Err(failure("Thermal sensors are required for this model profile.")); }
    if values.iter().any(|value| *value >= limit) {
        return Err(failure("Thermal stop: let the laptop cool and inspect the fan before restarting."));
    }
    Ok(())
}

pub fn verify_file(path: &Path, expected_bytes: Option<u64>, expected_sha256: &str) -> Result<(), BackendError> {
    if !valid_digest(expected_sha256) { return Err(failure("The artifact checksum is invalid.")); }
    let metadata = fs::symlink_metadata(path).map_err(|_| failure("A required model artifact is unavailable."))?;
    if !metadata.file_type().is_file() || expected_bytes.map(|bytes| metadata.len() != bytes).unwrap_or(false) {
        return Err(failure("Model artifact integrity check failed. Refusing to start."));
    }
    let mut file = File::open(path).map_err(|_| failure("A required model artifact is unavailable."))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| failure("Could not verify a model artifact."))?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != expected_sha256.to_ascii_lowercase() {
        return Err(failure("Model artifact integrity check failed. Refusing to start."));
    }
    Ok(())
}

pub fn verify_private_directory(path: &Path, expected_uid: u32) -> Result<(), BackendError> {
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
        return Err(failure("A private absolute runtime directory is required."));
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| failure("The private runtime directory is unavailable."))?;
        if metadata.file_type().is_symlink() { return Err(failure("Symlinks are not allowed in the private runtime path.")); }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| failure("The private runtime directory is unavailable."))?;
    if !metadata.is_dir() || metadata.uid() != expected_uid || metadata.mode() & 0o777 != 0o700 {
        return Err(failure("The runtime directory must belong to this user with mode 0700."));
    }
    Ok(())
}

async fn private_slot_directory(runtime: &Path, expected_uid: u32) -> Result<PathBuf, BackendError> {
    verify_private_directory(runtime, expected_uid)?;
    let output = timeout(Duration::from_secs(5), Command::new("findmnt").args(["-n", "-o", "FSTYPE", "-T"]).arg(runtime).output()).await
        .map_err(|_| failure("Could not verify the RAM-backed runtime directory."))?
        .map_err(|_| failure("Could not verify the RAM-backed runtime directory."))?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "tmpfs" {
        return Err(failure("The private runtime directory must be RAM-backed (tmpfs)."));
    }
    let slot = runtime.join("offscript-model");
    if fs::symlink_metadata(&slot).is_err() {
        fs::DirBuilder::new().mode(0o700).create(&slot).map_err(|_| failure("Could not create the private slot directory."))?;
    }
    verify_private_directory(&slot, expected_uid)?;
    Ok(slot)
}

pub fn command_arguments(model: &Path, template: &Path, slot_dir: &Path, config: &ModelConfig) -> Vec<OsString> {
    let mut arguments = vec![OsString::from("-m"), model.as_os_str().to_owned()];
    for value in ["--alias", "offscript", "--host", "127.0.0.1", "--port", "8081", "--ctx-size"] {arguments.push(value.into());}
    arguments.push(config.context.to_string().into());
    for value in ["--parallel", "1", "--threads"] {arguments.push(value.into());}
    arguments.push(config.threads.to_string().into());
    arguments.push("--threads-batch".into()); arguments.push(config.threads.to_string().into());
    for value in ["--batch-size", "128", "--ubatch-size", "64", "--n-gpu-layers", "0", "--flash-attn", "off", "--cache-type-k", "f16", "--cache-type-v", "f16", "--cache-ram", "0", "--no-cache-idle-slots", "--no-context-shift", "--jinja", "--chat-template-file"] { arguments.push(value.into()); }
    arguments.push(template.as_os_str().to_owned());
    arguments.extend([OsString::from("--slots"), OsString::from("--slot-save-path"), slot_dir.as_os_str().to_owned(), OsString::from("--no-webui"), OsString::from("--log-disable")]);
    arguments
}

async fn terminate_child(child: &mut Child) -> Result<(), BackendError> {
    terminate_child_with_grace(child, Duration::from_secs(10)).await
}

async fn terminate_child_with_grace(child: &mut Child, grace: Duration) -> Result<(), BackendError> {
    if child.try_wait().map_err(|_| failure("Could not inspect the model process."))?.is_some() { return Ok(()); }
    let pid = child.id().and_then(|pid| i32::try_from(pid).ok()).ok_or_else(|| failure("The model process identity is unavailable."))?;
    match kill(Pid::from_raw(pid), Signal::SIGTERM) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
        Err(_) => return Err(failure("Could not stop the model process safely.")),
    }
    match timeout(grace, child.wait()).await {
        Ok(result) => {result.map_err(|_| failure("Could not reap the model process."))?;}
        Err(_) => {
            child.start_kill().map_err(|_| failure("Could not stop the model process after its shutdown deadline."))?;
            timeout(Duration::from_secs(5), child.wait()).await
                .map_err(|_| failure("Model process cleanup could not be confirmed."))?
                .map_err(|_| failure("Could not reap the model process."))?;
        }
    }
    Ok(())
}

pub async fn run(root: &Path) -> Result<(), BackendError> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) { return Err(failure("Run this model profile on the Samsung Linux x86_64 host.")); }
    let config = read_model_config(&root.join("self-host/model.json"))?;
    let memory = fs::read_to_string("/proc/meminfo").map_err(|_| failure("Memory readings are unavailable."))?;
    check_memory(parse_memory(&memory)?, &config)?;
    check_temperatures(&read_temperatures(Path::new("/sys/class/hwmon"))?, STARTUP_LIMIT_MILLICELSIUS)?;
    let model = root.join(".data/models").join(&config.filename);
    let template = root.join("self-host").join(&config.template.filename);
    let binary = root.join(".runtime/llama.cpp/build/bin/llama-server");
    let executable = fs::symlink_metadata(&binary).map_err(|_| failure("The prepared model executable is unavailable."))?;
    if !executable.file_type().is_file() || executable.mode() & 0o111 == 0 { return Err(failure("The prepared model executable is invalid.")); }
    let verify_model = model.clone(); let verify_template = template.clone(); let verify_config = config.clone();
    tokio::task::spawn_blocking(move || {
        verify_file(&verify_model, Some(verify_config.bytes), &verify_config.sha256)?;
        verify_file(&verify_template, None, &verify_config.template.sha256)
    }).await.map_err(|_| failure("The artifact integrity check did not finish."))??;
    // Hashing may be substantial: refresh both readiness checks before spawning.
    let memory = fs::read_to_string("/proc/meminfo").map_err(|_| failure("Memory readings are unavailable."))?;
    check_memory(parse_memory(&memory)?, &config)?;
    check_temperatures(&read_temperatures(Path::new("/sys/class/hwmon"))?, STARTUP_LIMIT_MILLICELSIUS)?;
    let uid = fs::metadata("/proc/self").map_err(|_| failure("Could not verify the runtime directory owner."))?.uid();
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("/run/user/{uid}")));
    let slot_dir = private_slot_directory(&runtime, uid).await?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|_| failure("Could not install model shutdown handling."))?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|_| failure("Could not install model shutdown handling."))?;
    let mut child = Command::new(binary).args(command_arguments(&model, &template, &slot_dir, &config))
        .env("OMP_NUM_THREADS", config.threads.to_string()).stdin(Stdio::null())
        .stdout(Stdio::inherit()).stderr(Stdio::inherit()).kill_on_drop(true).spawn()
        .map_err(|_| failure("Could not start the prepared model executable."))?;
    eprintln!("Starting one CPU inference slot on loopback. Prompt logging and cross-request caching are disabled.");
    let mut monitor = interval(Duration::from_secs(2));
    monitor.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = terminate.recv() => { terminate_child(&mut child).await?; return Ok(()); }
            _ = interrupt.recv() => { terminate_child(&mut child).await?; return Ok(()); }
            status = child.wait() => {
                let status = status.map_err(|_| failure("Could not observe the model process exit."))?;
                if status.success() { return Ok(()); }
                return Err(failure("The model stopped. Automatic restart is disabled."));
            }
            _ = monitor.tick() => {
                let thermal = read_temperatures(Path::new("/sys/class/hwmon"))
                    .and_then(|values| check_temperatures(&values, RUNNING_LIMIT_MILLICELSIUS));
                if let Err(error) = thermal { terminate_child(&mut child).await?; return Err(error); }
            }
        }
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_reaps_only_its_child_and_is_idempotent() {
        let mut child=Command::new("sleep").arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        terminate_child(&mut child).await.unwrap();
        assert!(child.try_wait().unwrap().is_some());
        terminate_child(&mut child).await.unwrap();
    }

    #[tokio::test]
    async fn an_uncooperative_child_is_killed_after_its_grace_and_reaped() {
        // The shell immediately execs sleep in the same PID with TERM ignored;
        // there are no grandchildren to orphan. Readiness removes signal races.
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child=Command::new("sh").args(["-c","trap '' TERM; printf 'ready\\n'; exec sleep 30"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        let mut output=BufReader::new(child.stdout.take().unwrap());
        let mut line=String::new();
        timeout(Duration::from_secs(2),output.read_line(&mut line)).await.unwrap().unwrap();
        assert_eq!(line,"ready\n");
        timeout(Duration::from_secs(2),terminate_child_with_grace(&mut child,Duration::from_millis(40))).await.unwrap().unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }
}
