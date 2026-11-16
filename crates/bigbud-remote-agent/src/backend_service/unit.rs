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
        "# bigbud account-service v1; user scope only\n[Unit]\nDescription=bigbud remote backend\nAfter={}\nStartLimitIntervalSec=300\nStartLimitBurst=6\n\n[Service]\nType=exec\nExecStart={launcher} --backend-service run {path} backend\nRestart={}\nRestartSec=1\nKillMode=control-group\nTimeoutStopSec=15\nSendSIGKILL=yes\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
        names.rust,
        if config.restart { "on-failure" } else { "no" }
    );
    let rust = format!(
        "# bigbud account-service v1; independent Rust terminal owner\n[Unit]\nDescription=bigbud Rust terminal supervisor\n\n[Service]\nType=exec\nExecStart={launcher} --backend-service run {path} rust\nRestart=no\nKillMode=control-group\nTimeoutStopSec=15\nSendSIGKILL=yes\nUMask=0077\n"
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
