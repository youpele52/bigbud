use super::{Result, ServiceConfig, ServiceError, ServiceRole, files};
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
#[path = "launch.files.rs"]
mod evidence;

/// Lifetime ownership uses the existing P4 lock and records, never a second admission store.
pub(super) struct LaunchGuard {
    root: PathBuf,
    lock: File,
    attempt: String,
    boot: String,
    /// Set once by whichever path settles this launch: the supervisor returning, or its exit seam.
    settled: Mutex<bool>,
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
            settled: Mutex::new(false),
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
        let guard = Arc::new(self);
        let exiting = Arc::clone(&guard);
        // The supervisor ends the process from its exit seam (accepted restart, signal drain)
        // without returning here, so that seam must settle the same receipt under this lock.
        if !crate::supervisor::register_exit_receipt(Some(Arc::new(move |code| {
            exiting.settle_exit(code)
        }))) {
            return Err(ServiceError::Invalid(
                "managed launch exit evidence is already owned",
            ));
        }
        // The callback runs in this exact service process, retaining the lock until final receipt.
        let result = supervisor(guard.root.clone());
        let mut settled = guard.settled_flag();
        if *settled {
            // The exit seam has settled this launch and is ending the process with its own code.
            drop(settled);
            loop {
                std::thread::park();
            }
        }
        *settled = true;
        let receipt = guard
            .same_reservation()
            .and_then(|()| evidence::receipt(&guard.root, if result.is_ok() { 0 } else { 1 }));
        drop(settled);
        // Clearing never fails; a refused install is the only false outcome.
        let _cleared = crate::supervisor::register_exit_receipt(None);
        receipt?;
        result
    }

    fn settled_flag(&self) -> MutexGuard<'_, bool> {
        // A poisoned flag still records whether a receipt path already ran.
        self.settled.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Exit-seam receipt. Only a settled signal drain (143) or an accepted, settled restart (0)
    /// proves the supervisor and its owned work have ended. An unsettled exit (1) writes nothing,
    /// so the backend keeps reporting unknown liveness and requires repair instead of a relaunch.
    pub(super) fn settle_exit(&self, code: i32) {
        let mut settled = self.settled_flag();
        if *settled {
            return;
        }
        *settled = true;
        let status = match code {
            0 => 0,
            143 => 143,
            _ => {
                eprintln!("managed launch left no exit receipt: owned-work settlement is unknown");
                return;
            }
        };
        if let Err(error) = self
            .same_reservation()
            .and_then(|()| evidence::receipt(&self.root, status))
        {
            eprintln!("managed launch exit receipt was not written: {error}");
        }
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
