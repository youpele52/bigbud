use super::{Result, ServiceConfig, ServiceError, ServiceRole, files};
use std::fs::File;
use std::path::PathBuf;
#[path = "launch.files.rs"]
mod evidence;

/// Lifetime ownership uses the existing P4 lock and records, never a second admission store.
pub(super) struct LaunchGuard {
    root: PathBuf,
    lock: File,
    attempt: String,
    boot: String,
}

impl LaunchGuard {
    pub(super) fn acquire(config: &ServiceConfig) -> Result<Self> {
        let guard = Self::with_boot(config, &evidence::boot_id()?)?;
        verify_service_owner(config, ServiceRole::Rust)?;
        Ok(guard)
    }

    pub(super) fn with_boot(config: &ServiceConfig, current_boot: &str) -> Result<Self> {
        config.validate_role(ServiceRole::Rust)?;
        if config.launch_attempt.is_empty()
            || config.launch_attempt.len() > 64
            || !config
                .launch_attempt
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !evidence::valid_boot(&config.launch_boot)
            || config.launch_boot != current_boot
        {
            return Err(ServiceError::Invalid(
                "service reservation identity is stale or invalid",
            ));
        }
        if config.prior_epoch != "fresh"
            && (config.prior_epoch.is_empty()
                || config.prior_epoch.len() > 256
                || !config.prior_epoch.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(ServiceError::Invalid("invalid P4 prior epoch projection"));
        }
        let root = config.rust_state.clone();
        let lock = evidence::lock(&root.join("launch.lock"))?;
        let guard = Self {
            root,
            lock,
            attempt: config.launch_attempt.clone(),
            boot: config.launch_boot.clone(),
        };
        guard.same_reservation()?;
        if config.prior_epoch == "fresh" {
            evidence::absent(&guard.root.join("epoch"))?;
            evidence::absent(&guard.root.join("operations.journal"))?;
        } else {
            // TS alone proves death, retires admissions and projects the expected old epoch
            // under its existing restart reservation. A changed epoch is an ambiguous retry.
            if files::read_epoch(&guard.root.join("epoch"))? != config.prior_epoch.as_bytes() {
                return Err(ServiceError::Invalid(
                    "prior Rust epoch changed; preserve ambiguous launch",
                ));
            }
            let journal = guard.root.join("operations.journal");
            match std::fs::symlink_metadata(&journal) {
                Ok(_) => files::private_file(&journal)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        evidence::absent(&guard.root.join("supervisor.sock"))?;
        evidence::absent(&guard.root.join("launch.exit"))?;
        Ok(guard)
    }

    fn same_reservation(&self) -> Result<()> {
        evidence::same_lock(&self.lock, &self.root.join("launch.lock"))?;
        if files::read_private(&self.root.join("launch.intent"), 64)? != self.attempt.as_bytes()
            || files::read_private(&self.root.join("launch.boot"), 64)? != self.boot.as_bytes()
        {
            return Err(ServiceError::Invalid(
                "service reservation no longer matches P4 preparation",
            ));
        }
        Ok(())
    }

    pub(super) fn run(self, supervisor: impl FnOnce(PathBuf) -> Result<()>) -> Result<()> {
        // Recheck the held lock/intent after potentially slow actual service-owner inspection.
        self.same_reservation()?;
        // The callback runs in this exact service process, retaining the lock until final receipt.
        let result = supervisor(self.root.clone());
        self.same_reservation()?;
        evidence::receipt(&self.root, if result.is_ok() { 0 } else { 1 })?;
        result
    }
}

#[cfg(test)]
#[path = "launch.tests.rs"]
mod tests;

pub(super) fn verify_service_owner(config: &ServiceConfig, role: ServiceRole) -> Result<()> {
    // The role entrypoint validates artifact pins once before reaching this owner-only fence.
    evidence::verify_launcher(&config.rust_binary)?;
    let manager = super::command::SystemManager;
    use super::command::Manager;
    let names = super::UnitNames::new(config);
    let name = match role {
        ServiceRole::Rust => names.rust,
        ServiceRole::Backend => names.backend,
    };
    let status = manager.run(
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
    use std::io::Read;
    let mut cgroup = String::new();
    File::open("/proc/self/cgroup")?
        .take(4097)
        .read_to_string(&mut cgroup)?;
    let expected = super::unit::unit_directory(config).join(&name);
    super::unit::require_staged(config, &super::unit::render_definition(config)?)?;
    verify_owner(
        &status,
        &cgroup,
        &name,
        &expected,
        files::uid()?,
        std::process::id(),
    )?;
    Ok(())
}

pub(super) fn verify_owner(
    status: &str,
    cgroups: &str,
    unit: &str,
    fragment: &std::path::Path,
    uid: u32,
    pid: u32,
) -> Result<()> {
    if status.len() > 4096 || cgroups.len() > 4096 {
        return Err(ServiceError::Invalid("service owner evidence is oversized"));
    }
    let mut main_pid = None;
    let mut control_group = None;
    let mut fragment_path = None;
    for line in status.lines() {
        if let Some(value) = line.strip_prefix("MainPID=") {
            if main_pid.replace(value).is_some() {
                return Err(ServiceError::Manager);
            }
        } else if let Some(value) = line.strip_prefix("ControlGroup=") {
            if control_group.replace(value).is_some() {
                return Err(ServiceError::Manager);
            }
        } else if let Some(value) = line.strip_prefix("FragmentPath=") {
            if fragment_path.replace(value).is_some() {
                return Err(ServiceError::Manager);
            }
        } else {
            return Err(ServiceError::Manager);
        }
    }
    let group = control_group.ok_or(ServiceError::Manager)?;
    let prefix = format!("/user.slice/user-{uid}.slice/user@{uid}.service/");
    if fragment_path.map(std::path::Path::new) != Some(fragment)
        || main_pid.and_then(|value| value.parse::<u32>().ok()) != Some(pid)
        || !group.starts_with(&prefix)
        || !group.ends_with(&format!("/{unit}"))
        || group.contains("/../")
        || group.chars().any(char::is_control)
        || cgroups
            .lines()
            .filter(|line| line.strip_prefix("0::") == Some(group))
            .count()
            != 1
    {
        return Err(ServiceError::Invalid(
            "service role requires its exact independent user-service cgroup owner",
        ));
    }
    Ok(())
}
