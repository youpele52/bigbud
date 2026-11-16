//! Explicit activation: canonical finite preflight precedes every boot-policy change.
#[cfg(unix)]
use super::ServiceRole;
use super::command::Manager;
use super::status::Prerequisites;
#[cfg(unix)]
use super::unit::{render_definition, require_staged, unit_directory};
use super::{Result, ServiceConfig, ServiceError};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
fn capability(text: &str) -> Result<()> {
    if text.len() > 1024 {
        return Err(ServiceError::Manager);
    }
    let body = text
        .trim()
        .strip_prefix('{')
        .and_then(|text| text.strip_suffix('}'))
        .ok_or(ServiceError::Manager)?;
    let mut fields = [false; 3];
    for item in body.split(',') {
        let (key, value) = item.split_once(':').ok_or(ServiceError::Manager)?;
        let index = match key.trim() {
            "\"schemaVersion\"" if value.trim() == "1" => 0,
            "\"accountServicePreflight\"" if value.trim() == "1" => 1,
            "\"backendVersion\"" => {
                let version = value
                    .trim()
                    .strip_prefix('"')
                    .and_then(|value| value.strip_suffix('"'))
                    .ok_or(ServiceError::Manager)?;
                if version.is_empty()
                    || version.len() > 128
                    || !version.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_')
                    })
                {
                    return Err(ServiceError::Manager);
                }
                2
            }
            _ => return Err(ServiceError::Manager),
        };
        let field = fields.get_mut(index).ok_or(ServiceError::Manager)?;
        if *field {
            return Err(ServiceError::Manager);
        }
        *field = true;
    }
    if fields != [true; 3] {
        return Err(ServiceError::Manager);
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn enable(
    config: &ServiceConfig,
    manager: &impl Manager,
    readiness: Prerequisites,
) -> Result<()> {
    if readiness != Prerequisites::Ready {
        return Err(ServiceError::Manager);
    }
    config.validate()?;
    super::cli::require_capability(config, manager, true)?;
    let definition = render_definition(config)?;
    require_staged(config, &definition)?;
    // No credentials or internal markers reach old/unknown Node entrypoints.
    let mut probe = std::process::Command::new(&config.node_binary);
    probe
        .env_clear()
        .env("HOME", &config.home)
        .env("PATH", config.runtime_path()?)
        .env("LANG", "C.UTF-8")
        .arg(&config.backend_entry)
        .arg("--remote-service-capabilities");
    capability(&manager.run_owned(probe, Duration::from_secs(10))?)?;
    let mut finite = config.command(ServiceRole::Backend)?;
    finite.env("BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY", "1");
    // Exit0 is canonical preflight completion, not a new persistent readiness record.
    // Do not retry uncertain admission or stop an already running independent Rust service.
    let _bounded_preflight_output = manager.run_owned(finite, Duration::from_secs(120))?;
    // Preflight can mutate the P4 config projection. Re-read the exact stable private config;
    // use its current pins and definitions rather than the stale invocation projection.
    let current = ServiceConfig::load(&config.config_path())?;
    let mut projected = config.clone();
    projected.launch_attempt = current.launch_attempt.clone();
    projected.prior_epoch = current.prior_epoch.clone();
    projected.launch_boot = current.launch_boot.clone();
    if current != projected {
        return Err(ServiceError::Manager);
    }
    let definition = render_definition(&current)?;
    require_staged(&current, &definition)?;
    manager.run("/usr/bin/systemctl", &args(&["daemon-reload"]))?;
    let fragment = manager.run(
        "/usr/bin/systemctl",
        &args(&["show", &definition.names.backend, "--property=FragmentPath"]),
    )?;
    if fragment
        != format!(
            "FragmentPath={}\n",
            unit_directory(&current)
                .join(&definition.names.backend)
                .display()
        )
    {
        return Err(ServiceError::Manager);
    }
    if ServiceConfig::load(&current.config_path())? != current {
        return Err(ServiceError::Manager);
    }
    require_staged(&current, &definition)?;
    // Rust is static and MUST NOT be enabled. Successful finite reconciliation has already
    // started/admitted it through its independent explicit service path if necessary.
    manager.run(
        "/usr/bin/systemctl",
        &args(&["enable", &definition.names.backend]),
    )?;
    manager.run(
        "/usr/bin/systemctl",
        &args(&["start", &definition.names.backend]),
    )?;
    Ok(())
}
#[cfg(unix)]
fn args(arguments: &[&str]) -> Vec<String> {
    ["--user", "--no-pager", "--no-ask-password"]
        .into_iter()
        .chain(arguments.iter().copied())
        .map(str::to_owned)
        .collect()
}
#[cfg(not(unix))]
pub(super) fn enable(
    _config: &ServiceConfig,
    _manager: &impl Manager,
    _readiness: Prerequisites,
) -> Result<()> {
    Err(ServiceError::Unsupported)
}
#[cfg(all(test, unix))]
#[path = "enable.tests.rs"]
mod tests;
