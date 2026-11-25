#[cfg(any(test, target_os = "linux"))]
use super::password;
use super::{ErrorCode, PinnedSsh, SSH, Stamp, Transport, paths};
use std::{
    path::Path,
    process::{Command, Stdio},
};

#[cfg(test)]
pub(super) fn validate_fixture(transport: &Transport) -> Result<Stamp, ErrorCode> {
    validate_fixture_for_auth(transport, false)
}

pub(super) fn validate_fixture_for_auth(
    transport: &Transport,
    password: bool,
) -> Result<Stamp, ErrorCode> {
    if !transport.config.host.is_loopback()
        || transport.config.ssh != Path::new(SSH)
        || transport.proof_agent.is_some()
    {
        return Err(ErrorCode::ConfigUnsupported);
    }
    transport.revalidate_policy()?;
    transport.identities.apply_to(&mut Command::new(SSH))?;
    if password {
        #[cfg(any(test, target_os = "linux"))]
        password::validate_target(transport)?;
        #[cfg(target_os = "linux")]
        return paths::bound_executable(Path::new(SSH));
        #[cfg(all(not(test), not(target_os = "linux")))]
        return Err(ErrorCode::ConfigUnsupported);
    }
    #[cfg(target_os = "linux")]
    if transport.images.require_mounted_linux_fixture().is_ok() {
        return paths::bound_executable(Path::new(SSH));
    }
    paths::executable(Path::new(SSH))
}

#[cfg(test)]
pub(super) fn master_command(
    pinned: &PinnedSsh,
    socket: &Path,
    host: &str,
    auth_options: &[&str],
) -> Command {
    master_command_for_link(pinned, socket, host, auth_options, false)
}

pub(super) fn master_command_for_link(
    pinned: &PinnedSsh,
    socket: &Path,
    host: &str,
    auth_options: &[&str],
    forwarded: bool,
) -> Command {
    // First-set-wins: add the master's overrides before the pinned defaults.
    // No -f, no persist and no remote command.
    let mut control_path = std::ffi::OsString::from("ControlPath=");
    control_path.push(socket);
    let mut command = Command::new(SSH);
    command
        .args(["-N", "-o", "ControlMaster=yes", "-o"])
        .arg(control_path);
    if forwarded {
        // The exact special value "-" is OpenSSH's native stdin/stdout
        // transport. No proxy command interpreter or shell is invoked.
        command.args(["-o", "ProxyCommand=-"]);
    }
    for option in auth_options {
        command.args(["-o", option]);
    }
    command
        .args(pinned.command.get_args())
        .args(["--", host])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}
