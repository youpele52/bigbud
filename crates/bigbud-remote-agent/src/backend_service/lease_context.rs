//! Opaque managed-account provenance, minted only after actual Rust unit ownership.
use super::{Result, ServiceConfig, ServiceError, ServiceRole};
#[cfg(unix)]
use crate::service_lease::{Controller, Peer};
use std::path::Path;
#[path = "lease_context.executable.rs"]
mod executable;

#[cfg(target_os = "linux")]
pub(super) fn require_pinned_executable(pid: u32, path: &Path, sha256: &str) -> Result<()> {
    executable::ExecutablePin::default().require(pid, path, sha256)
}

/// Checks this proxy's actual Node parent without minting Rust service ownership.
#[cfg(target_os = "linux")]
pub(super) fn require_proxy_controller(config: &ServiceConfig) -> Result<()> {
    let context = ManagedAccountContext {
        config: config.clone(),
        node_pin: executable::ExecutablePin::default(),
    };
    let peer = Peer::current_process().map_err(|_| ServiceError::Manager)?;
    context.authorize(&peer, false)?;
    Ok(())
}

pub struct ManagedAccountContext {
    config: ServiceConfig,
    node_pin: executable::ExecutablePin,
}
impl ManagedAccountContext {
    #[cfg(unix)]
    pub(super) fn acquire(config: &ServiceConfig) -> Result<Self> {
        config.validate_role(ServiceRole::Rust)?;
        super::launch::verify_service_owner(config, ServiceRole::Rust)?;
        Ok(Self {
            config: config.clone(),
            node_pin: executable::ExecutablePin::default(),
        })
    }
    pub(crate) fn validate_guard(&self, guard: &crate::service_lease::Guard) -> Result<()> {
        let root = self.config.home.join(".bigbud/agent");
        let control = root.join("control-v1");
        guard
            .require_scope(
                &control.join("registry.json"),
                &[root.as_path(), control.as_path()],
            )
            .map_err(|_| ServiceError::Invalid("lease guard is outside canonical state"))
    }
    pub(crate) fn assets(
        &self,
        generation: String,
        size: u64,
        sha256: Vec<u8>,
        argument: String,
    ) -> Result<crate::service_lease::AssetsResource> {
        let state = super::authority::reserved_backend_state(&self.config)?;
        crate::service_lease::AssetsResource::new(
            state,
            generation,
            size,
            sha256.try_into().map_err(|_| ServiceError::Manager)?,
            argument,
        )
        .map_err(|_| ServiceError::Invalid("invalid original assets reference"))
    }
    pub(crate) fn authority(&self) -> &str {
        &self.config.authority
    }
    pub(crate) fn installation(&self) -> &str {
        &self.config.expected_installation_fingerprint
    }

    #[cfg(unix)]
    pub(crate) fn authorize(&self, peer: &Peer, launch: bool) -> Result<Controller> {
        if !cfg!(target_os = "linux") {
            return Err(ServiceError::Unsupported);
        }
        let current = ServiceConfig::definition(&self.config.config_path())?;
        if current.authority != self.config.authority
            || current.home != self.config.home
            || current.backend_home != self.config.backend_home
            || current.rust_state != self.config.rust_state
            || current.rust_binary != self.config.rust_binary
            || current.rust_sha256 != self.config.rust_sha256
            || current.expected_installation_fingerprint
                != self.config.expected_installation_fingerprint
            || current.authority_reservation_sha256 != self.config.authority_reservation_sha256
        {
            return Err(ServiceError::Invalid(
                "managed lease account binding changed",
            ));
        }
        super::unit::require_staged(&current, &super::unit::render_definition(&current)?)?;
        current.validate_role(if launch {
            ServiceRole::Backend
        } else {
            ServiceRole::Rust
        })?;
        if !peer.current().map_err(|_| ServiceError::Manager)? {
            return Err(ServiceError::Invalid("native lease peer identity changed"));
        }
        use super::command::Manager;
        let name = super::UnitNames::new(&current).backend;
        let status = super::command::SystemManager.run(
            "/usr/bin/systemctl",
            &[
                "--user".into(),
                "--no-pager".into(),
                "--no-ask-password".into(),
                "show".into(),
                name.clone(),
                "--property=MainPID,ControlGroup,FragmentPath".into(),
            ],
        )?;
        let pid = backend_pid(&status)?;
        if peer.parent_pid() != pid {
            return Err(ServiceError::Invalid(
                "lease proxy is not the designated Node owner child",
            ));
        }
        let controller = Controller::read(pid).map_err(|_| ServiceError::Manager)?;
        let node_group = read_proc(pid, "cgroup")?;
        let peer_group = read_proc(peer.pid(), "cgroup")?;
        super::launch::verify_owner(
            &status,
            &node_group,
            &name,
            &super::unit::unit_directory(&current).join(&name),
            super::files::uid()?,
            pid,
        )?;
        if node_group != peer_group {
            return Err(ServiceError::Invalid("lease peer is outside backend unit"));
        }
        self.node_pin
            .require(pid, &current.node_binary, &current.node_sha256)?;
        require_executable(peer.pid(), &current.rust_binary)?;
        if Controller::read(pid).map_err(|_| ServiceError::Manager)? != controller
            || !peer.current().map_err(|_| ServiceError::Manager)?
        {
            return Err(ServiceError::Invalid(
                "lease controller changed during authorization",
            ));
        }
        Ok(controller)
    }
}
#[cfg(unix)]
fn read_proc(pid: u32, name: &str) -> Result<String> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(format!("/proc/{pid}/{name}"))?
        .take(4097)
        .read_to_string(&mut text)?;
    if text.len() > 4096 {
        return Err(ServiceError::Manager);
    }
    Ok(text)
}
#[cfg(unix)]
fn require_executable(pid: u32, expected: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let executable = std::path::PathBuf::from(format!("/proc/{pid}/exe"));
    let actual = std::fs::metadata(&executable)?;
    let pinned = std::fs::symlink_metadata(expected)?;
    if std::fs::canonicalize(executable)? != expected
        || !pinned.is_file()
        || actual.dev() != pinned.dev()
        || actual.ino() != pinned.ino()
    {
        return Err(ServiceError::Invalid("lease controller executable changed"));
    }
    Ok(())
}
fn backend_pid(status: &str) -> Result<u32> {
    if status.len() > 4096 {
        return Err(ServiceError::Manager);
    }
    let mut values = status.lines().filter_map(|s| s.strip_prefix("MainPID="));
    let pid = values
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|p| *p > 1)
        .ok_or(ServiceError::Manager)?;
    if values.next().is_some() {
        return Err(ServiceError::Manager);
    }
    Ok(pid)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backend_controller_pid_is_exact_and_unambiguous() {
        assert!(matches!(
            backend_pid("MainPID=42\nControlGroup=/unit\n"),
            Ok(42)
        ));
        for value in [
            "MainPID=0",
            "MainPID=1",
            "MainPID=42\nMainPID=43",
            "MainPID=-1",
            "",
        ] {
            assert!(backend_pid(value).is_err());
        }
    }
}
