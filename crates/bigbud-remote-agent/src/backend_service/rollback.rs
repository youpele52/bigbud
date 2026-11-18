//! Launcher-side rollback of a runtime update whose new runtime never starts (M3 WP-4D).
//!
//! The backend unit's ExecStart is this launcher, so it runs before every Node start. When the
//! backend's update journal (`rollback.files.rs`) is `restarting`, the service config may point
//! at a switched runtime that is still on trial. The backend clears the journal before it opens
//! command admission, so a `restarting` journal also proves that no command was admitted since
//! the switch, and a rollback here can never drop acknowledged work.
//!
//! - **Switched runtime:** every launch is counted next to the journal. A launch whose Node
//!   cannot be verified, cannot exec or exits before its trial passes is followed by another
//!   launch, so after `MAX_FAILED_LAUNCHES` the next launch restores the previous pins instead.
//!   That takes 4 starts, inside the unit's `StartLimitBurst=6`, so the unit never reaches its
//!   start limit first.
//! - **Half-switched pair:** the backend writes the receipt, then the config. The config is the
//!   commit point: a previous config with a different receipt means the switch stopped between
//!   the two renames, so the previous runtime is restored deterministically.
//! - **`rollback` phase:** a rollback the backend or this launcher started is finished.
//!
//! A restore stages the previous receipt, runs the existing verifier on the previous pins against
//! it and changes nothing when that fails. Then it writes the journal `rollback` (with the
//! reason), renames the receipt, replaces the config (only the graph pins change, so a newer
//! Rust reservation in the config survives) and writes the journal `restore-pending`. The
//! previous runtime then restores the database backup and settles the operation as failed
//! through the backend's existing rollback path; the launcher never touches the database.
use super::{Result, ServiceConfig, ServiceError, ServiceRole, files};
use sha2::{Digest, Sha256};
use std::path::Path;

#[path = "rollback.files.rs"]
mod journal;
#[cfg(test)]
#[path = "rollback.tests.rs"]
mod tests;

/// Launches of a switched runtime allowed before the next launch rolls back.
pub(super) const MAX_FAILED_LAUNCHES: u32 = 3;
const HALF_SWITCHED: &str = "The runtime switch stopped between the receipt and the config; the launcher restored the previous runtime.";

/// Returns the config to launch: as given, or reloaded after restoring the previous runtime.
/// `fence` proves this process is the managed backend unit before anything is written.
pub(super) fn reconcile(
    config: ServiceConfig,
    fence: impl FnOnce(&ServiceConfig) -> Result<()>,
) -> Result<ServiceConfig> {
    let dir = journal::update_dir(&config);
    let journal = match journal::read(&dir) {
        Ok(Some(journal)) => journal,
        Ok(None) => return Ok(config),
        Err(error) => {
            eprintln!("runtime update journal not usable; launching as configured: {error}");
            return Ok(config);
        }
    };
    match journal.phase.as_str() {
        "rollback" => {
            fence(&config)?;
            restore(&config, &dir, &journal, None)
        }
        "restarting" => restarting(config, &dir, &journal, fence),
        _ => Ok(config),
    }
}

fn restarting(
    config: ServiceConfig,
    dir: &Path,
    journal: &journal::Journal,
    fence: impl FnOnce(&ServiceConfig) -> Result<()>,
) -> Result<ServiceConfig> {
    let previous = match previous_pins(&config, journal) {
        Ok(previous) => previous,
        Err(error) => {
            eprintln!("runtime update journal has no usable previous runtime: {error}");
            return Ok(config);
        }
    };
    if same_pins(&config, &previous) {
        // The previous runtime is configured; its own trial check decides, unless the pair is
        // half-switched and cannot launch at all.
        if receipt_digest(&config).as_deref() == Some(config.receipt_sha256.as_str()) {
            return Ok(config);
        }
        fence(&config)?;
        return restore(&config, dir, journal, Some(HALF_SWITCHED));
    }
    fence(&config)?;
    let attempt = match journal::bump_attempts(dir, &journal.operation_id, &config.receipt_sha256) {
        Ok(attempt) => attempt,
        Err(error) => {
            eprintln!("runtime update launch attempt not counted: {error}");
            return Ok(config);
        }
    };
    if attempt <= MAX_FAILED_LAUNCHES {
        eprintln!("runtime update trial launch {attempt} of {MAX_FAILED_LAUNCHES}");
        return Ok(config);
    }
    let reason = format!(
        "The new runtime did not start after {MAX_FAILED_LAUNCHES} launches; the launcher restored the previous runtime."
    );
    restore(&config, dir, journal, Some(&reason))
}

/// The current config with the journal's previous graph pins; nothing else may come from it.
fn previous_pins(config: &ServiceConfig, journal: &journal::Journal) -> Result<ServiceConfig> {
    let previous = ServiceConfig::parse(&journal.previous_config)?;
    if previous.authority != config.authority
        || previous.home != config.home
        || previous.backend_home != config.backend_home
        || format!("{:x}", Sha256::digest(journal.previous_receipt.as_bytes()))
            != previous.receipt_sha256
    {
        return Err(ServiceError::Invalid(
            "the journal's previous runtime does not belong to this service",
        ));
    }
    let mut merged = config.clone();
    merged.node_binary = previous.node_binary;
    merged.node_sha256 = previous.node_sha256;
    merged.backend_entry = previous.backend_entry;
    merged.backend_sha256 = previous.backend_sha256;
    merged.receipt_sha256 = previous.receipt_sha256;
    Ok(merged)
}

fn same_pins(left: &ServiceConfig, right: &ServiceConfig) -> bool {
    left.node_binary == right.node_binary
        && left.node_sha256 == right.node_sha256
        && left.backend_entry == right.backend_entry
        && left.backend_sha256 == right.backend_sha256
        && left.receipt_sha256 == right.receipt_sha256
}

fn receipt_digest(config: &ServiceConfig) -> Option<String> {
    files::read_private(&config.receipt_path(), 16 * 1024 * 1024)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

/// Verifies, then switches the pins back. Every step repeats safely after a crash: a journal in
/// `rollback` is finished on the next launch.
fn restore(
    config: &ServiceConfig,
    dir: &Path,
    journal: &journal::Journal,
    failure: Option<&str>,
) -> Result<ServiceConfig> {
    let previous = previous_pins(config, journal)?;
    let config_dir = config.config_dir();
    let staged = config_dir.join(".artifact-receipt.rollback");
    journal::stage_private(&staged, journal.previous_receipt.as_bytes())?;
    if let Err(error) = previous.validate_role_at(ServiceRole::Backend, &staged) {
        let _ = std::fs::remove_file(&staged);
        eprintln!("the previous runtime failed verification; nothing was changed: {error}");
        return Err(error);
    }
    let encoded = match previous.encode() {
        Ok(encoded) => encoded,
        Err(error) => {
            let _ = std::fs::remove_file(&staged);
            return Err(error);
        }
    };
    if let Some(failure) = failure {
        journal::write_phase(dir, journal, "rollback", Some(failure))?;
    }
    std::fs::rename(&staged, config.receipt_path())?;
    journal::replace_private(&config_dir, &config.config_path(), encoded.as_bytes())?;
    journal::write_phase(dir, journal, "restore-pending", failure)?;
    if let Err(error) = journal::clear_attempts(dir) {
        eprintln!("runtime update launch counter not cleared: {error}");
    }
    eprintln!("runtime update rolled back to the previous runtime; the backend restores its data");
    ServiceConfig::definition(&config.config_path())
}
