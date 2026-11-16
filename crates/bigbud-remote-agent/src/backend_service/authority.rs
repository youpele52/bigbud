#[cfg(unix)]
use super::files;
use super::{Result, ServiceConfig, ServiceError};
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::collections::BTreeMap;
#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
const KEYS: [&str; 10] = [
    "version",
    "authority",
    "installation",
    "agent_root",
    "backend_home",
    "backend_home_dev",
    "backend_home_ino",
    "backend_state",
    "backend_state_dev",
    "backend_state_ino",
];

#[cfg(unix)]
pub(super) fn root_fingerprint(
    root: &str,
    uid: u32,
    dev: u64,
    ino: u64,
    authority: &str,
    installation: &str,
) -> String {
    let input = [
        "bigbud.local-supervisor.authority.v1".to_owned(),
        root.into(),
        uid.to_string(),
        dev.to_string(),
        ino.to_string(),
        authority.into(),
        installation.into(),
    ];
    format!("sha256:{:x}", Sha256::digest(input.join("\0").as_bytes()))
}
#[cfg(unix)]
fn field<'a>(record: &'a BTreeMap<&str, &str>, key: &str) -> Result<&'a str> {
    record.get(key).copied().ok_or(ServiceError::Invalid(
        "incomplete account authority reservation",
    ))
}
#[cfg(unix)]
fn decode(text: &str) -> Result<BTreeMap<&str, &str>> {
    if text.len() > 16 * 1024
        || text
            .chars()
            .any(|value| value.is_control() && value != '\n')
    {
        return Err(ServiceError::Invalid(
            "invalid account authority reservation text",
        ));
    }
    let mut record = BTreeMap::new();
    for line in text.lines() {
        let (key, value) = line.split_once('=').ok_or(ServiceError::Invalid(
            "invalid account authority reservation field",
        ))?;
        if !KEYS.contains(&key) || value.is_empty() || record.insert(key, value).is_some() {
            return Err(ServiceError::Invalid(
                "unknown or duplicate account authority reservation field",
            ));
        }
    }
    if record.len() != KEYS.len() || field(&record, "version")? != "1" {
        return Err(ServiceError::Invalid(
            "unsupported account authority reservation",
        ));
    }
    Ok(record)
}
#[cfg(unix)]
fn tuple(record: &BTreeMap<&str, &str>, name: &str, actual: u64) -> Result<()> {
    let value = field(record, name)?;
    if value.parse::<u64>().ok() != Some(actual) || value != actual.to_string() {
        return Err(ServiceError::Invalid(
            "backend filesystem ownership tuple changed",
        ));
    }
    Ok(())
}

/// Pinned explicit setup reservation, not an admission registry or process/key epoch identity.
pub(super) fn verify(config: &ServiceConfig) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = config;
        Err(ServiceError::Unsupported)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let agent = config.home.join(".bigbud/agent");
        files::directory(&agent, &[0o700])?;
        let before = std::fs::symlink_metadata(&agent)?;
        let bytes = files::read_private(&agent.join("account-authority-v1"), 16 * 1024)?;
        if format!("{:x}", Sha256::digest(&bytes)) != config.authority_reservation_sha256 {
            return Err(ServiceError::Invalid(
                "account authority reservation byte pin changed",
            ));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| ServiceError::Invalid("account authority reservation must be UTF-8"))?;
        let record = decode(text)?;
        if field(&record, "authority")? != config.authority
            || field(&record, "installation")? != config.expected_installation_fingerprint
        {
            return Err(ServiceError::Invalid(
                "account supervisor belongs to another backend installation",
            ));
        }
        let expected = root_fingerprint(
            agent
                .to_str()
                .ok_or(ServiceError::Invalid("non-UTF-8 agent root"))?,
            before.uid(),
            before.dev(),
            before.ino(),
            &config.authority,
            &config.expected_installation_fingerprint,
        );
        if field(&record, "agent_root")? != expected {
            return Err(ServiceError::Invalid(
                "account supervisor root was copied or replaced",
            ));
        }
        let base = Path::new(field(&record, "backend_home")?);
        if base.as_os_str() != config.backend_home.as_os_str() {
            return Err(ServiceError::Invalid(
                "backend base differs from its authority reservation",
            ));
        }
        files::directory(base, &[0o700])?;
        let base_stat = std::fs::symlink_metadata(base)?;
        tuple(&record, "backend_home_dev", base_stat.dev())?;
        tuple(&record, "backend_home_ino", base_stat.ino())?;
        let state = Path::new(field(&record, "backend_state")?);
        let child = state
            .strip_prefix(base)
            .map_err(|_| ServiceError::Invalid("backend state is outside its reserved base"))?;
        if child.as_os_str().is_empty() {
            return Err(ServiceError::Invalid(
                "backend state must be beneath its reserved base",
            ));
        }
        files::directory(state, &[0o700])?;
        let state_stat = std::fs::symlink_metadata(state)?;
        tuple(&record, "backend_state_dev", state_stat.dev())?;
        tuple(&record, "backend_state_ino", state_stat.ino())?;
        files::directory(&agent, &[0o700])?;
        let after = std::fs::symlink_metadata(&agent)?;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(ServiceError::Invalid(
                "account supervisor root changed during verification",
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
#[path = "authority.tests.rs"]
mod tests;

/// Return only the backend state from the same fully verified, byte-pinned reservation.
#[cfg(unix)]
pub(super) fn reserved_backend_state(config: &ServiceConfig) -> Result<std::path::PathBuf> {
    verify(config)?;
    let bytes = files::read_private(
        &config.home.join(".bigbud/agent/account-authority-v1"),
        16 * 1024,
    )?;
    if format!("{:x}", Sha256::digest(&bytes)) != config.authority_reservation_sha256 {
        return Err(ServiceError::Invalid(
            "account reservation changed during state projection",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| ServiceError::Invalid("account reservation encoding changed"))?;
    let record = decode(text)?;
    let state = std::path::PathBuf::from(field(&record, "backend_state")?);
    files::directory(&state, &[0o700])?;
    use std::os::unix::fs::MetadataExt;
    let info = std::fs::symlink_metadata(&state)?;
    tuple(&record, "backend_state_dev", info.dev())?;
    tuple(&record, "backend_state_ino", info.ino())?;
    Ok(state)
}
