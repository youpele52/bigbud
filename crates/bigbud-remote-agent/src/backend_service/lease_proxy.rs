//! Authenticate the connected managed Rust unit before touching private stdin.
use super::{Result, ServiceError};
#[cfg(target_os = "linux")]
use super::{ServiceConfig, ServiceRole, command::Manager};
#[cfg(target_os = "linux")]
use std::os::unix::{
    fs::{FileTypeExt, MetadataExt},
    net::UnixStream,
};
use std::path::Path;

pub(super) fn run(path: &Path) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err(ServiceError::Unsupported)
    }
    #[cfg(target_os = "linux")]
    {
        let config = ServiceConfig::definition(path)?;
        config.validate_role(ServiceRole::Rust)?;
        super::lease_context::require_pinned_executable(
            std::process::id(),
            &config.rust_binary,
            &config.rust_sha256,
        )?;
        super::lease_context::require_proxy_controller(&config)?;
        let stream = connect(&config, &super::command::SystemManager)?;
        let output = std::io::stdout();
        crate::supervisor::forward_authenticated_proxy(std::io::stdin(), output.lock(), stream)?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn connect(config: &ServiceConfig, manager: &impl Manager) -> Result<UnixStream> {
    let path = crate::state::supervisor_socket_path(&config.rust_state);
    let before = std::fs::symlink_metadata(&path)?;
    if !before.file_type().is_socket()
        || before.uid() != super::files::uid()?
        || before.mode() & 0o7777 != 0o700
        || before.nlink() != 1
        || std::fs::canonicalize(&path)? != path
    {
        return Err(ServiceError::Invalid(
            "managed supervisor socket ownership changed",
        ));
    }
    let stream = bounded_connect(&path)?;
    config.validate_role(ServiceRole::Rust)?;
    authenticate(config, &stream, manager)?;
    let after = std::fs::symlink_metadata(path)?;
    if (
        before.dev(),
        before.ino(),
        before.ctime(),
        before.ctime_nsec(),
        before.mode(),
    ) != (
        after.dev(),
        after.ino(),
        after.ctime(),
        after.ctime_nsec(),
        after.mode(),
    ) || ServiceConfig::definition(&config.config_path())? != *config
    {
        return Err(ServiceError::Invalid(
            "managed supervisor binding changed during connection",
        ));
    }
    Ok(stream)
}

#[cfg(target_os = "linux")]
fn authenticate(config: &ServiceConfig, stream: &UnixStream, manager: &impl Manager) -> Result<()> {
    let peer = crate::service_lease::Peer::read(stream).map_err(|_| ServiceError::Manager)?;
    let name = super::UnitNames::new(config).rust;
    let arguments = [
        "--user".into(),
        "--no-pager".into(),
        "--no-ask-password".into(),
        "show".into(),
        name.clone(),
        "--property=MainPID,ControlGroup,FragmentPath".into(),
    ];
    let status = manager.run("/usr/bin/systemctl", &arguments)?;
    use std::io::Read;
    let mut group = String::new();
    std::fs::File::open(format!("/proc/{}/cgroup", peer.pid()))?
        .take(4097)
        .read_to_string(&mut group)?;
    super::unit::require_staged(config, &super::unit::render_definition(config)?)?;
    super::launch::verify_owner(
        &status,
        &group,
        &name,
        &super::unit::unit_directory(config).join(&name),
        super::files::uid()?,
        peer.pid(),
    )?;
    super::lease_context::require_pinned_executable(
        peer.pid(),
        &config.rust_binary,
        &config.rust_sha256,
    )?;
    if !peer.current().map_err(|_| ServiceError::Manager)?
        || manager.run("/usr/bin/systemctl", &arguments)? != status
    {
        return Err(ServiceError::Invalid(
            "managed supervisor kernel identity changed",
        ));
    }
    Ok(())
}

/// Nonblocking connect: a full accept backlog cannot retain a private proxy forever.
/// Shared with service-lease successor recovery, which needs the same bounded refusal proof.
#[cfg(target_os = "linux")]
pub(crate) fn bounded_connect(path: &Path) -> Result<UnixStream> {
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    };
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: zero is a valid empty sockaddr_un; fields are initialized before connect.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(ServiceError::Invalid(
            "managed supervisor socket path is invalid",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, source) in address.sun_path.iter_mut().zip(bytes) {
        *target = *source as libc::c_char;
    }
    // SAFETY: socket creates an owned descriptor with no borrowed memory.
    let raw = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
        )
    };
    if raw < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: raw is a fresh successful socket descriptor, now owned exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: address is initialized, correct family/length, and outlives this call.
    let result = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error.into());
        }
        let mut event = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: event is a single initialized writable pollfd, bounded 250ms.
        if unsafe { libc::poll(&mut event, 1, 250) } != 1 {
            return Err(ServiceError::Manager);
        }
        let mut error = 0i32;
        let mut length = std::mem::size_of_val(&error) as libc::socklen_t;
        // SAFETY: initialized writable integer and matching length for SO_ERROR.
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut i32).cast(),
                &mut length,
            )
        } != 0
            || length as usize != std::mem::size_of_val(&error)
            || error != 0
        {
            return Err(ServiceError::Manager);
        }
    }
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(false)?;
    Ok(stream)
}

#[cfg(all(test, target_os = "linux"))]
#[path = "lease_proxy.tests.rs"]
mod tests;

#[cfg(test)]
mod arguments {
    #[test]
    #[allow(clippy::expect_used)]
    fn managed_proxy_rejects_missing_or_extra_arguments_before_config_io() {
        use crate::backend_service::run_cli;
        assert!(run_cli(["proxy"].into_iter().map(str::to_owned)).is_err());
        let error = run_cli(
            ["proxy", "/not-read", "extra"]
                .into_iter()
                .map(str::to_owned),
        )
        .expect_err("extra arguments must refuse before reading a config");
        assert!(
            error
                .to_string()
                .contains("unexpected managed proxy arguments")
        );
    }
}
