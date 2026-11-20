use super::{Result, ServiceError};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prerequisites {
    Unsupported,
    MissingUserManager,
    UnsupportedManagerVersion,
    MissingLinger,
    Ready,
}
impl Prerequisites {
    pub fn remediation(self, uid: u32) -> String {
        match self {
            Self::Unsupported => "Explicit launch remains available; this host needs Linux systemd user services for boot startup.".into(),
            Self::MissingUserManager => format!("Run systemctl --user status. Ask the host administrator to provide a working user manager for UID {uid}; do not install a root service."),
            Self::UnsupportedManagerVersion => "systemd 240 or newer is required for the generated exec/start-limit policy. Ask the host administrator to update the user manager; explicit launch remains available.".into(),
            Self::MissingLinger => format!("Boot/logout startup is unavailable. Ask the host administrator about loginctl enable-linger {uid}, then check loginctl show-user {uid} --property=Linger --value. bigbud does not enable lingering."),
            Self::Ready => "User manager and lingering are present; actual logout/reboot/application readiness still require host qualification.".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    NotInstalled,
    Disabled,
    Starting,
    Active,
    Stopped,
    NeedsRepair,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitStatus {
    pub state: ServiceState,
    pub restarts: u32,
}
impl UnitStatus {
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 64 * 1024 {
            return Err(ServiceError::Invalid("service status output is oversized"));
        }
        let mut values = BTreeMap::new();
        for line in text.lines() {
            let (key, value) = line
                .split_once('=')
                .ok_or(ServiceError::Invalid("malformed systemd status"))?;
            if values.insert(key, value).is_some() {
                return Err(ServiceError::Invalid("duplicate systemd status field"));
            }
        }
        let field = |name| {
            values
                .get(name)
                .copied()
                .ok_or(ServiceError::Invalid("incomplete systemd status"))
        };
        let load = field("LoadState")?;
        if load == "not-found" {
            return Ok(Self {
                state: ServiceState::NotInstalled,
                restarts: 0,
            });
        }
        let active = field("ActiveState")?;
        let result = field("Result")?;
        let enabled = field("UnitFileState")?;
        let restarts = field("NRestarts")?
            .parse()
            .map_err(|_| ServiceError::Invalid("invalid systemd restart count"))?;
        let state = match (load, active, result, enabled) {
            ("not-found", _, _, _) => ServiceState::NotInstalled,
            (_, "failed", _, _) | (_, _, "start-limit-hit", _) => ServiceState::NeedsRepair,
            ("loaded", "active", _, _) => ServiceState::Active,
            ("loaded", "activating", _, _) => ServiceState::Starting,
            ("loaded", "inactive", _, "disabled") => ServiceState::Disabled,
            ("loaded", "inactive", _, "enabled" | "static") => ServiceState::Stopped,
            _ => ServiceState::Unknown,
        };
        Ok(Self { state, restarts })
    }
}

pub(super) fn unit_arguments(name: &str) -> Vec<String> {
    [
        "--user",
        "--no-pager",
        "--no-ask-password",
        "show",
        name,
        "--property=LoadState,ActiveState,SubState,Result,UnitFileState,NRestarts",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Repair for a failed or start-limited unit. The Rust unit is never started directly: only the
/// backend projects the fresh launch reservation it needs, so a direct start replays a spent one.
pub(super) fn repair_steps(name: &str, names: &super::UnitNames) -> String {
    format!(
        "Inspect journalctl --user-unit={name} --no-pager -n 50 and repair the cause. Then run systemctl --user reset-failed {} {} and bigbud backend start; the backend relaunches its Rust unit itself. Do not start {} directly. If the backend then reports that the old supervisor has no verified live or dead identity, its terminal work did not settle: leave the state in place and reboot, which proves the old supervisor ended. Interrupted turns are not replayed by this launcher.",
        names.backend, names.rust, names.rust
    )
}
