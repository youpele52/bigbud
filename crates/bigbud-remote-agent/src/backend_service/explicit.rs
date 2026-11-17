//! D8 explicit launch without boot startup: `start` and `stop` act on the staged account units
//! for this session only. They never enable, disable or change lingering.
use super::command::{Manager, systemctl_args as args};
use super::status::{Prerequisites, ServiceState, UnitStatus, unit_arguments};
use super::unit::{UnitFiles, render_definition, render_units, require_staged, unit_directory};
use super::{Result, ServiceConfig, ServiceError};
use std::time::Duration;

/// Type=exec start returns once the backend has been executed; readiness is not awaited here.
const START_DEADLINE: Duration = Duration::from_secs(30);
/// Both units use TimeoutStopSec=15 before SIGKILL; one stop job may wait for both in turn.
const STOP_DEADLINE: Duration = Duration::from_secs(45);
const SYSTEMCTL: &str = "/usr/bin/systemctl";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Explicit {
    Start,
    Stop,
}
impl Explicit {
    pub(super) fn parse(operation: &str) -> Option<Self> {
        match operation {
            "start" => Some(Self::Start),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

fn staged(config: &ServiceConfig, rendered: &UnitFiles) -> Result<()> {
    match require_staged(config, rendered) {
        Err(ServiceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Err(
            ServiceError::Invalid("account units are not staged; run backend setup first"),
        ),
        other => other,
    }
}

/// Starts only the backend unit: its own finite reconciliation projects a fresh P4 reservation
/// and starts the Rust unit through `start-rust`. Starting the Rust unit directly would run it
/// against the stale recorded reservation, fail, and count toward its crash limit.
/// Stop ends both units in one job; systemd stops the backend before the Rust unit it follows.
pub(super) fn run(
    config: &ServiceConfig,
    operation: Explicit,
    manager: &impl Manager,
    readiness: Prerequisites,
) -> Result<Vec<(String, UnitStatus)>> {
    if !matches!(
        readiness,
        Prerequisites::Ready | Prerequisites::MissingLinger
    ) {
        return Err(ServiceError::Invalid(
            "explicit start/stop needs a working systemd user manager; run backend status for remediation",
        ));
    }
    let rendered = match operation {
        Explicit::Start => render_units(config)?,
        // A changed or missing artifact must never prevent stopping already-running work.
        Explicit::Stop => render_definition(config)?,
    };
    staged(config, &rendered)?;
    if operation == Explicit::Start {
        super::cli::require_capability(config, manager, true)?;
        manager.run(SYSTEMCTL, &args(&["daemon-reload"]))?;
    }
    for name in [&rendered.names.backend, &rendered.names.rust] {
        let fragment = manager.run(SYSTEMCTL, &args(&["show", name, "--property=FragmentPath"]))?;
        if fragment
            != format!(
                "FragmentPath={}\n",
                unit_directory(config).join(name).display()
            )
        {
            return Err(ServiceError::Invalid(
                "the user manager selected a different account unit; preserve it and repair explicitly",
            ));
        }
    }
    match operation {
        Explicit::Start => manager.run_bounded(
            SYSTEMCTL,
            &args(&["start", &rendered.names.backend]),
            START_DEADLINE,
        )?,
        Explicit::Stop => manager.run_bounded(
            SYSTEMCTL,
            &args(&["stop", &rendered.names.backend, &rendered.names.rust]),
            STOP_DEADLINE,
        )?,
    };
    let mut observed = Vec::with_capacity(2);
    for name in [rendered.names.backend, rendered.names.rust] {
        let status = UnitStatus::parse(&manager.run(SYSTEMCTL, &unit_arguments(&name))?)?;
        observed.push((name, status));
    }
    let settled = match operation {
        Explicit::Start => observed.first().is_some_and(|(_, status)| {
            matches!(status.state, ServiceState::Starting | ServiceState::Active)
        }),
        Explicit::Stop => observed.iter().all(|(_, status)| {
            matches!(status.state, ServiceState::Stopped | ServiceState::Disabled)
        }),
    };
    if !settled {
        for (name, status) in &observed {
            eprintln!(
                "{name}: {:?}; crash-restarts={}",
                status.state, status.restarts
            );
        }
        return Err(ServiceError::Manager);
    }
    Ok(observed)
}

/// CLI boundary: consent flags belong to boot policy and are refused here.
pub(super) fn report(
    config: &ServiceConfig,
    operation: Explicit,
    consent: bool,
    manager: &impl Manager,
    readiness: Prerequisites,
    uid: u32,
) -> Result<()> {
    if consent {
        return Err(ServiceError::Invalid(
            "start and stop take no startup consent; use enable for boot startup",
        ));
    }
    let observed = run(config, operation, manager, readiness)?;
    if readiness != Prerequisites::Ready {
        println!("{}", readiness.remediation(uid));
    }
    for (name, status) in observed {
        println!(
            "{name}: {:?}; crash-restarts={}",
            status.state, status.restarts
        );
    }
    println!(
        "{}",
        match operation {
            Explicit::Start =>
                "Backend unit started for this session; boot startup and lingering are unchanged. The backend starts and admits its Rust unit itself; unit state is not backend readiness.",
            Explicit::Stop =>
                "Backend and Rust units stopped; boot startup and lingering are unchanged. Configuration, backend data and Rust state were preserved. Work running in these units, including Rust terminals, has ended.",
        }
    );
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "explicit.tests.rs"]
mod tests;
