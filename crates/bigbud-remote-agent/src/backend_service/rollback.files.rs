//! The runtime-update journal and the launch-attempt counter as the launcher sees them.
//!
//! The backend owns the journal (`runtimeUpdate.journal.ts`): `<backend_home>/userdata/
//! runtime-update/activation-v1.json`, a private file in a private directory. The launcher only
//! reads it and rewrites `phase`/`failure`, keeping every other field as written. The counter
//! `launch-attempts-v1` beside it holds `<operationId>\n<receipt_sha256>\n<count>\n`, so a count
//! belongs to one operation and one switched runtime; anything else counts from zero.
use super::{Result, ServiceConfig, ServiceError, files};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const JOURNAL: &str = "activation-v1.json";
const ATTEMPTS: &str = "launch-attempts-v1";
/// The journal embeds the previous receipt (bounded at 16 MiB by the verifier) and config.
const MAX_JOURNAL: u64 = 33 * 1024 * 1024;

pub(super) struct Journal {
    pub(super) operation_id: String,
    pub(super) phase: String,
    pub(super) previous_config: String,
    pub(super) previous_receipt: String,
    raw: Map<String, Value>,
}

fn invalid() -> ServiceError {
    ServiceError::Invalid("the runtime update journal is invalid; preserve it for repair")
}

/// The backend's state directory in remote mode is `<BIGBUD_HOME>/userdata`.
pub(super) fn update_dir(config: &ServiceConfig) -> PathBuf {
    config.backend_home.join("userdata/runtime-update")
}

fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn text(raw: &Map<String, Value>, key: &str) -> Result<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(invalid)
}

pub(super) fn read(dir: &Path) -> Result<Option<Journal>> {
    let path = dir.join(JOURNAL);
    if !present(&path)? {
        return Ok(None);
    }
    files::directory(dir, &[0o700])?;
    let bytes = files::read_private(&path, MAX_JOURNAL)?;
    let raw = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(raw)) => raw,
        _ => return Err(invalid()),
    };
    let operation_id = text(&raw, "operationId")?;
    if raw.get("revision").and_then(Value::as_u64) != Some(1)
        || operation_id.is_empty()
        || operation_id.len() > 64
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !matches!(raw.get("failure"), Some(Value::Null | Value::String(_)))
    {
        return Err(invalid());
    }
    Ok(Some(Journal {
        operation_id,
        phase: text(&raw, "phase")?,
        previous_config: text(&raw, "previousConfig")?,
        previous_receipt: text(&raw, "previousReceipt")?,
        raw,
    }))
}

/// Rewrites the journal's phase (and failure, when given); every other field is kept.
pub(super) fn write_phase(
    dir: &Path,
    journal: &Journal,
    phase: &str,
    failure: Option<&str>,
) -> Result<()> {
    let mut raw = journal.raw.clone();
    raw.insert("phase".into(), Value::String(phase.into()));
    if let Some(failure) = failure {
        raw.insert("failure".into(), Value::String(failure.into()));
    }
    let mut text = serde_json::to_string(&Value::Object(raw)).map_err(|_| invalid())?;
    text.push('\n');
    replace_private(dir, &dir.join(JOURNAL), text.as_bytes())
}

/// Counts one more launch of `receipt` for `operation_id` and returns the new count.
pub(super) fn bump_attempts(dir: &Path, operation_id: &str, receipt: &str) -> Result<u32> {
    let path = dir.join(ATTEMPTS);
    let prior = if present(&path)? {
        let bytes = files::read_private(&path, 256)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines = text.lines();
        match (lines.next(), lines.next(), lines.next(), lines.next()) {
            (Some(id), Some(sha), Some(count), None) if id == operation_id && sha == receipt => {
                count.parse::<u32>().unwrap_or(0)
            }
            _ => 0,
        }
    } else {
        0
    };
    let next = prior.saturating_add(1);
    replace_private(
        dir,
        &path,
        format!("{operation_id}\n{receipt}\n{next}\n").as_bytes(),
    )?;
    Ok(next)
}

pub(super) fn clear_attempts(dir: &Path) -> Result<()> {
    match fs::remove_file(dir.join(ATTEMPTS)) {
        Ok(()) => File::open(dir)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Creates `path` afresh as a private 0600 file holding `bytes`, flushed to disk.
pub(super) fn stage_private(path: &Path, bytes: &[u8]) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => (),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Atomic private replace: temporary file, fsync, rename, directory fsync.
pub(super) fn replace_private(dir: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ServiceError::Invalid("invalid private file name"))?;
    let temporary = dir.join(format!(".{name}.launcher-{}.tmp", std::process::id()));
    stage_private(&temporary, bytes)?;
    fs::rename(&temporary, target)?;
    File::open(dir)?.sync_all()?;
    Ok(())
}
