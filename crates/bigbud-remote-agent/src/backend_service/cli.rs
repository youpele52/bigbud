use super::command::{Manager, SystemManager};
use super::status::{Prerequisites, UnitStatus, unit_arguments};
use super::unit::{UnitNames, reload_if_changed, render_definition, require_staged, stage_units};
use super::{Result, ServiceConfig, ServiceError, ServiceRole, files, render_units};
use std::path::Path;

fn manager_args(operation: &str, names: &UnitNames) -> Vec<String> {
    [
        "--user",
        "--no-pager",
        "--no-ask-password",
        operation,
        &names.rust,
        &names.backend,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub(super) fn prerequisites(manager: &impl Manager, uid: u32, linux: bool) -> Prerequisites {
    if !linux || uid == 0 {
        return Prerequisites::Unsupported;
    }
    let version = match manager.run(
        "/usr/bin/systemctl",
        &[
            "--user".into(),
            "--no-pager".into(),
            "--no-ask-password".into(),
            "show".into(),
            "--property=Version".into(),
        ],
    ) {
        Ok(value) => value,
        Err(_) => return Prerequisites::MissingUserManager,
    };
    let version = version
        .lines()
        .find_map(|line| line.strip_prefix("Version="))
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse::<u32>().ok());
    if version.is_none_or(|value| value < 240) {
        return Prerequisites::UnsupportedManagerVersion;
    }
    match manager.run(
        "/usr/bin/loginctl",
        &[
            "show-user".into(),
            uid.to_string(),
            "--property=Linger".into(),
            "--value".into(),
        ],
    ) {
        Ok(value) if value.trim() == "yes" => Prerequisites::Ready,
        _ => Prerequisites::MissingLinger,
    }
}

pub(super) fn require_capability(
    config: &ServiceConfig,
    manager: &impl Manager,
    require_graph: bool,
) -> Result<()> {
    let identity = manager.run(
        config
            .rust_binary
            .to_str()
            .ok_or(ServiceError::Invalid("non-UTF-8 launcher"))?,
        &["--check".into(), "--capabilities".into()],
    )?;
    if !identity
        .split_whitespace()
        .any(|field| field == "backend-service=2")
        || (require_graph
            && !identity
                .split_whitespace()
                .any(|field| field == "backend-service-graph=1"))
    {
        return Err(ServiceError::Invalid(
            "the verified Rust artifact lacks account-service support; preserve it and select a compatible signed release",
        ));
    }
    Ok(())
}

pub(super) fn apply(
    config: &ServiceConfig,
    operation: &str,
    consent: bool,
    manager: &impl Manager,
    readiness: Prerequisites,
) -> Result<()> {
    if matches!(operation, "stage" | "enable") && !consent {
        return Err(ServiceError::ConsentRequired);
    }
    if operation == "enable" {
        return super::enable::enable(config, manager, readiness);
    }
    if operation == "start-rust" {
        if !consent {
            return Err(ServiceError::ConsentRequired);
        }
        // Like explicit start, a session without lingering may run the units; they stop at
        // logout, which the caller reports with the lingering remediation.
        if !matches!(
            readiness,
            Prerequisites::Ready | Prerequisites::MissingLinger
        ) {
            return Err(ServiceError::Invalid(
                "the Rust unit needs a working systemd user manager; run backend status for remediation",
            ));
        }
        config.validate_role(ServiceRole::Rust)?;
        require_capability(config, manager, false)?;
        let rendered = render_definition(config)?;
        require_staged(config, &rendered)?;
        // Never an unconditional reload: it would reset the backend's crash-loop start limit.
        reload_if_changed(manager, &[&rendered.names.rust])?;
        let fragment = manager.run(
            "/usr/bin/systemctl",
            &[
                "--user".into(),
                "--no-pager".into(),
                "--no-ask-password".into(),
                "show".into(),
                rendered.names.rust.clone(),
                "--property=FragmentPath".into(),
            ],
        )?;
        let expected = super::unit::unit_directory(config).join(&rendered.names.rust);
        if fragment != format!("FragmentPath={}\n", expected.display()) {
            return Err(ServiceError::Invalid(
                "the user manager selected a different Rust unit; preserve it and repair explicitly",
            ));
        }
        manager.run(
            "/usr/bin/systemctl",
            &[
                "--user".into(),
                "--no-pager".into(),
                "--no-ask-password".into(),
                "start".into(),
                rendered.names.rust,
            ],
        )?;
        return Ok(());
    }
    let rendered = if operation == "disable" {
        render_definition(config)?
    } else {
        render_units(config)?
    };
    if matches!(operation, "stage" | "enable") {
        require_capability(config, manager, true)?;
    }
    if operation == "stage" {
        return stage_units(config, &rendered);
    }
    require_staged(config, &rendered)?;
    match operation {
        "disable" => {
            manager.run(
                "/usr/bin/systemctl",
                &manager_args("disable", &rendered.names),
            )?;
        }
        _ => {
            return Err(ServiceError::Invalid(
                "unsupported account-service operation",
            ));
        }
    }
    Ok(())
}

pub fn run_cli(args: impl Iterator<Item = String>) -> Result<()> {
    run_cli_with_supervisor(args, |_, _| Err(ServiceError::Unsupported))
}

pub fn run_cli_with_supervisor(
    args: impl Iterator<Item = String>,
    supervisor: impl FnOnce(std::path::PathBuf, super::ManagedAccountContext) -> Result<()>,
) -> Result<()> {
    #[cfg(not(unix))]
    let _ = &supervisor;
    let args: Vec<_> = args.collect();
    let operation = args
        .first()
        .map(String::as_str)
        .ok_or(ServiceError::Invalid(
            "expected render, stage, enable, disable, start, stop, status or run",
        ))?;
    if !matches!(
        operation,
        "render"
            | "stage"
            | "enable"
            | "disable"
            | "start"
            | "stop"
            | "status"
            | "run"
            | "start-rust"
            | "proxy"
    ) {
        return Err(ServiceError::Invalid(
            "unsupported account-service operation",
        ));
    }
    let path = args.get(1).ok_or(ServiceError::Invalid(
        "expected the stable private config path",
    ))?;
    if operation == "proxy" {
        if args.len() != 2 {
            return Err(ServiceError::Invalid("unexpected managed proxy arguments"));
        }
        #[cfg(unix)]
        return super::lease_proxy::run(Path::new(path));
        #[cfg(not(unix))]
        return Err(ServiceError::Unsupported);
    }
    if operation == "run" {
        let role = match args.get(2).map(String::as_str) {
            Some("backend") => ServiceRole::Backend,
            Some("rust") => ServiceRole::Rust,
            _ => {
                return Err(ServiceError::Invalid(
                    "expected backend or rust service role",
                ));
            }
        };
        if args.len() != 3 {
            return Err(ServiceError::Invalid(
                "unexpected account-service arguments",
            ));
        }
        if !cfg!(target_os = "linux") || files::uid()? == 0 {
            return Err(ServiceError::Unsupported);
        }
        let config = ServiceConfig::definition(Path::new(path))?;
        #[cfg(unix)]
        if role == ServiceRole::Rust {
            let guard = super::launch::LaunchGuard::acquire(&config)?;
            let context = super::lease_context::ManagedAccountContext::acquire(&config)?;
            return guard.run(|root| supervisor(root, context));
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let mut command = config.command(role)?;
            super::launch::verify_service_owner(&config, role)?;
            // Pinned command and exact live user-unit ownership are both required before exec.
            return Err(command.exec().into());
        }
        #[cfg(not(unix))]
        {
            let _ = (config, role);
            return Err(ServiceError::Unsupported);
        }
    }
    let consent = args.get(2).map(String::as_str) == Some("--confirm-startup");
    if args.len() > 3 || (args.len() == 3 && !consent) {
        return Err(ServiceError::Invalid(
            "unexpected account-service arguments",
        ));
    }
    let config = ServiceConfig::definition(Path::new(path))?;
    if operation == "render" {
        let units = render_units(&config)?;
        println!(
            "# {}\n{}\n# {}\n{}",
            units.names.rust, units.rust, units.names.backend, units.backend
        );
        return Ok(());
    }
    let manager = SystemManager;
    let uid = files::uid()?;
    let ready = prerequisites(&manager, uid, cfg!(target_os = "linux"));
    if operation == "status" {
        println!("{}", ready.remediation(uid));
        if matches!(
            ready,
            Prerequisites::MissingUserManager
                | Prerequisites::Unsupported
                | Prerequisites::UnsupportedManagerVersion
        ) {
            return Ok(());
        }
        let names = UnitNames::new(&config);
        for name in [&names.rust, &names.backend] {
            let value = manager.run("/usr/bin/systemctl", &unit_arguments(name))?;
            let status = UnitStatus::parse(&value)?;
            println!(
                "{name}: {:?}; crash-restarts={}",
                status.state, status.restarts
            );
            if status.state == super::status::ServiceState::NeedsRepair {
                println!("{}", super::status::repair_steps(name, &names));
            }
        }
        return Ok(());
    }
    if !cfg!(target_os = "linux") || uid == 0 {
        return Err(ServiceError::Unsupported);
    }
    if let Some(explicit) = super::explicit::Explicit::parse(operation) {
        return super::explicit::report(&config, explicit, consent, &manager, ready, uid);
    }
    if operation == "enable" && ready != Prerequisites::Ready {
        eprintln!("{}", ready.remediation(uid));
    }
    apply(&config, operation, consent, &manager, ready)?;
    if operation == "start-rust" {
        if ready != Prerequisites::Ready {
            eprintln!("{}", ready.remediation(uid));
        }
        println!(
            "Independent Rust unit start acknowledged; P4 readiness and authenticated admission must still verify the attempt and epoch."
        );
        return Ok(());
    }
    println!(
        "Startup configuration updated; existing processes and data were preserved. No service was started or stopped. Explicit launch/re-adoption and actual logout/reboot qualification remain separate."
    );
    Ok(())
}
