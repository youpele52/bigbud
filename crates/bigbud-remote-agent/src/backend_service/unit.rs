use super::command::{Manager, systemctl_args};
use super::{Result, ServiceConfig, ServiceError, files};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitNames {
    pub backend: String,
    pub rust: String,
}
impl UnitNames {
    pub fn new(config: &ServiceConfig) -> Self {
        Self {
            backend: format!("bigbud-backend-{}.service", config.authority),
            rust: format!("bigbud-rust-{}.service", config.authority),
        }
    }
}
#[derive(Debug)]
pub struct UnitFiles {
    pub names: UnitNames,
    pub backend: String,
    pub rust: String,
}

fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}

/// The start limit should count crash restarts, not deliberate stop/start cycles. systemd 249 has
/// no failure-only start limit, and `systemctl reset-failed` is its documented way to flush a
/// unit's start-rate counter. So only after a clean stop (`SERVICE_RESULT=success`) does the unit
/// flush its own counter; crashes and failed starts keep counting toward `StartLimitBurst`.
/// The leading `-` keeps a failed flush from failing an otherwise clean stop. The backend's
/// unit-reference parser accepts exactly this line, so the two must change together.
pub(super) const BACKEND_STOP_POST: &str = "ExecStopPost=-/bin/sh -c 'case $$SERVICE_RESULT in success) exec /usr/bin/systemctl --user --no-ask-password reset-failed $$1;; esac' sh %n";

pub fn render_units(config: &ServiceConfig) -> Result<UnitFiles> {
    config.validate()?;
    render_definition(config)
}

pub(super) fn render_definition(config: &ServiceConfig) -> Result<UnitFiles> {
    let names = UnitNames::new(config);
    let launcher = quote(
        config
            .rust_binary
            .to_str()
            .ok_or(ServiceError::Invalid("non-UTF-8 launcher path"))?,
    );
    let path = quote(
        config
            .config_path()
            .to_str()
            .ok_or(ServiceError::Invalid("non-UTF-8 config path"))?,
    );
    let backend = format!(
        "# bigbud account-service v1; user scope only\n[Unit]\nDescription=bigbud remote backend\nAfter={}\nStartLimitIntervalSec=300\nStartLimitBurst=6\n\n[Service]\nType=exec\nExecStart={launcher} --backend-service run {path} backend\n{BACKEND_STOP_POST}\nRestart={}\nRestartSec=1\nKillMode=control-group\nTimeoutStopSec=15\nSendSIGKILL=yes\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
        names.rust,
        if config.restart { "on-failure" } else { "no" }
    );
    // 143 is the supervisor's settled signal drain (WP-0A); 1 (unsettled) and crashes still fail.
    let rust = format!(
        "# bigbud account-service v1; independent Rust terminal owner\n[Unit]\nDescription=bigbud Rust terminal supervisor\n\n[Service]\nType=exec\nExecStart={launcher} --backend-service run {path} rust\nSuccessExitStatus=143\nRestart=no\nKillMode=control-group\nTimeoutStopSec=15\nSendSIGKILL=yes\nUMask=0077\n"
    );
    Ok(UnitFiles {
        names,
        backend,
        rust,
    })
}

pub(super) fn unit_directory(config: &ServiceConfig) -> PathBuf {
    config.home.join(".config/systemd/user")
}

/// No clobber: existing user units remain authoritative, including similarly named units.
pub(super) fn stage_units(config: &ServiceConfig, rendered: &UnitFiles) -> Result<()> {
    let paths = [
        config.home.join(".config"),
        config.home.join(".config/systemd"),
        unit_directory(config),
    ];
    for path in &paths {
        match fs::symlink_metadata(path) {
            Ok(_) => files::directory(path, &[0o700, 0o750, 0o755])?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    let units = [
        (&rendered.names.rust, &rendered.rust),
        (&rendered.names.backend, &rendered.backend),
    ];
    for (name, contents) in units {
        let path = unit_directory(config).join(name);
        match files::read_private(&path, 64 * 1024) {
            Ok(bytes) if bytes == contents.as_bytes() => (),
            Ok(_) => {
                return Err(ServiceError::Invalid(
                    "an existing user unit differs; preserve it and repair explicitly",
                ));
            }
            Err(ServiceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    for path in &paths {
        match fs::create_dir(path) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        files::directory(path, &[0o700, 0o750, 0o755])?;
    }
    for (name, contents) in units {
        let path = unit_directory(config).join(name);
        let temporary = unit_directory(config).join(format!(".{name}.staging"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&temporary, &path) {
            Ok(()) => (),
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && files::read_private(&path, 64 * 1024)? == contents.as_bytes() => {}
            Err(error) => return Err(error.into()),
        }
        fs::remove_file(&temporary)?;
    }
    std::fs::File::open(unit_directory(config))?.sync_all()?;
    Ok(())
}

pub(super) fn require_staged(config: &ServiceConfig, rendered: &UnitFiles) -> Result<()> {
    for (name, contents) in [
        (&rendered.names.backend, &rendered.backend),
        (&rendered.names.rust, &rendered.rust),
    ] {
        if files::read_private(&unit_directory(config).join(name), 64 * 1024)?
            != contents.as_bytes()
        {
            return Err(ServiceError::Invalid(
                "account units differ from the private launch configuration",
            ));
        }
    }
    Ok(())
}

/// Reloads the user manager only when a unit is not loaded yet or its file changed on disk.
/// A reload also discards start-rate counters, so an unconditional reload would let an explicit
/// start or a Rust relaunch silently revive a backend that hit its crash-loop limit.
pub(super) fn reload_if_changed(manager: &impl Manager, names: &[&String]) -> Result<bool> {
    let mut stale = false;
    for name in names {
        let text = manager.run(
            "/usr/bin/systemctl",
            &systemctl_args(&["show", name, "--property=NeedDaemonReload,LoadState"]),
        )?;
        let mut reload = None;
        let mut load = None;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("NeedDaemonReload=") {
                reload = Some(value == "yes");
            } else if let Some(value) = line.strip_prefix("LoadState=") {
                load = Some(value == "loaded");
            }
        }
        // Anything but a loaded, current unit (including unparsable output) needs the reload.
        stale |= reload != Some(false) || load != Some(true);
    }
    if stale {
        manager.run("/usr/bin/systemctl", &systemctl_args(&["daemon-reload"]))?;
    }
    Ok(stale)
}
