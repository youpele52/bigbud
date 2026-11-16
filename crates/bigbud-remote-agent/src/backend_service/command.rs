use super::{Result, ServiceError};
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
#[path = "command.run.rs"]
mod owned;
#[cfg(unix)]
pub(crate) use owned::run_with_executable;

#[cfg(unix)]
pub(super) fn user_bus(command: &mut Command, directory: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    super::files::directory(directory, &[0o700])?;
    let socket = directory.join("bus");
    let metadata = std::fs::symlink_metadata(&socket)?;
    if !metadata.file_type().is_socket() || metadata.uid() != super::files::uid()? {
        return Err(ServiceError::Manager);
    }
    command.env("XDG_RUNTIME_DIR", directory).env(
        "DBUS_SESSION_BUS_ADDRESS",
        format!("unix:path={}", socket.display()),
    );
    Ok(())
}

pub(super) trait Manager {
    fn run(&self, program: &str, args: &[String]) -> Result<String>;
    #[cfg(unix)]
    fn run_owned(&self, _command: Command, _timeout: std::time::Duration) -> Result<String> {
        Err(ServiceError::Unsupported)
    }
}
pub(super) struct SystemManager;
impl Manager for SystemManager {
    #[cfg(unix)]
    fn run_owned(&self, command: Command, timeout: std::time::Duration) -> Result<String> {
        let (output, status) = owned::run(command, timeout, 64 * 1024)?;
        if status != 0 {
            return Err(ServiceError::Manager);
        }
        Ok(output)
    }
    fn run(&self, program: &str, args: &[String]) -> Result<String> {
        if !cfg!(target_os = "linux") {
            return Err(ServiceError::Unsupported);
        }
        #[cfg(not(unix))]
        {
            let _ = (program, args);
            Err(ServiceError::Unsupported)
        }
        #[cfg(unix)]
        {
            let mut command = Command::new(program);
            command
                .args(args)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("LANG", "C.UTF-8");
            if program == "/usr/bin/systemctl" {
                user_bus(
                    &mut command,
                    &std::path::PathBuf::from(format!("/run/user/{}", super::files::uid()?)),
                )?;
            }
            let (text, status) =
                owned::run(command, std::time::Duration::from_secs(10), 64 * 1024)?;
            let absent_unit = program == "/usr/bin/systemctl"
                && args
                    .iter()
                    .any(|arg| arg.starts_with("--property=LoadState,"))
                && text.lines().any(|line| line == "LoadState=not-found");
            if status != 0 && !absent_unit {
                return Err(ServiceError::Manager);
            }
            Ok(text)
        }
    }
}
