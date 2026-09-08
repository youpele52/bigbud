use std::io;
use std::path::Path;
use std::time::Duration;

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

use crate::identity;

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorPreparation {
    Ready,
    StartRequired,
    BlockedActiveWork,
}

#[cfg(unix)]
pub fn prepare_supervisor(socket_path: &Path) -> io::Result<SupervisorPreparation> {
    prepare_supervisor_for_identity(
        socket_path,
        identity::build_version(),
        identity::build_digest(),
    )
}

#[cfg(unix)]
fn prepare_supervisor_for_identity(
    socket_path: &Path,
    expected_version: &str,
    expected_digest: &str,
) -> io::Result<SupervisorPreparation> {
    let metadata = match std::fs::symlink_metadata(socket_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SupervisorPreparation::StartRequired);
        }
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor socket ownership or permissions are invalid",
        ));
    }

    let mut stream = match UnixStream::connect(socket_path) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(SupervisorPreparation::StartRequired);
        }
        Err(error) => return Err(error),
    };
    let peer_pid = verified_peer_pid(&stream)?;
    write_frame(
        &mut stream,
        &v1::Frame {
            payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: format!("prepare-{}", std::process::id()),
                connection_id: format!("prepare-{}", std::process::id()),
                server_nonce: format!("prepare-{}", std::process::id()),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            })),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .map_err(io::Error::other)?;
    let response = read_frame(&mut stream, DEFAULT_MAX_FRAME_BYTES)
        .map_err(io::Error::other)?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "supervisor closed during identity verification",
            )
        })?;
    match response.payload {
        Some(v1::frame::Payload::AgentHello(hello)) => {
            if hello.agent_version.is_empty()
                || hello.build_digest.is_empty()
                || hello.agent_epoch.is_empty()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "supervisor returned incomplete identity metadata",
                ));
            }
            if hello.agent_version == expected_version && hello.build_digest == expected_digest {
                return Ok(SupervisorPreparation::Ready);
            }
        }
        Some(v1::frame::Payload::ProtocolError(error))
            if error.code == "UNSUPPORTED_PROTOCOL_MAJOR" =>
        {
            // The recognized response authenticates the private socket as an
            // older bigbud supervisor. Apply the same active-work guard below.
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "supervisor returned an invalid identity response",
            ));
        }
    }

    let journal_path = socket_path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid supervisor socket"))?
        .join("operations.journal");
    if take_over_mismatched_supervisor(&stream, peer_pid, &journal_path)?
        == SupervisorPreparation::BlockedActiveWork
    {
        return Ok(SupervisorPreparation::BlockedActiveWork);
    }
    drop(stream);
    for _ in 0..50 {
        if UnixStream::connect(socket_path).is_err() {
            return Ok(SupervisorPreparation::StartRequired);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "mismatched supervisor did not stop after SIGTERM",
    ))
}

#[cfg(target_os = "linux")]
fn take_over_mismatched_supervisor(
    stream: &UnixStream,
    peer_pid: libc::pid_t,
    journal_path: &Path,
) -> io::Result<SupervisorPreparation> {
    if verified_peer_pid(stream)? != peer_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor peer identity changed during takeover",
        ));
    }
    let peer = PeerProcess::open(peer_pid)?;
    let mut resume = ResumeGuard::stop(peer)?;
    let journal_has_active_work =
        crate::operations::journal::inspect_active_operations(journal_path).unwrap_or(true);
    if journal_has_active_work || has_live_children(peer_pid)? {
        return Ok(SupervisorPreparation::BlockedActiveWork);
    }
    resume.terminate()?;
    Ok(SupervisorPreparation::StartRequired)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn take_over_mismatched_supervisor(
    _stream: &UnixStream,
    _peer_pid: libc::pid_t,
    _journal_path: &Path,
) -> io::Result<SupervisorPreparation> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "verified supervisor takeover is supported on Linux",
    ))
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct PeerProcess {
    pid: libc::pid_t,
    pidfd: Option<std::os::fd::OwnedFd>,
}

#[cfg(target_os = "linux")]
impl PeerProcess {
    fn open(pid: libc::pid_t) -> io::Result<Self> {
        use std::os::fd::{FromRawFd, OwnedFd};

        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
        if fd >= 0 {
            return Ok(Self {
                pid,
                pidfd: Some(unsafe { OwnedFd::from_raw_fd(fd) }),
            });
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOSYS) {
            return Ok(Self { pid, pidfd: None });
        }
        Err(error)
    }

    fn signal(&self, signal: libc::c_int) -> io::Result<()> {
        use std::os::fd::AsRawFd;

        let result = match &self.pidfd {
            Some(pidfd) => unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            },
            None => unsafe { libc::kill(self.pid, signal) as libc::c_long },
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(target_os = "linux")]
struct ResumeGuard {
    peer: PeerProcess,
    armed: bool,
}

#[cfg(target_os = "linux")]
impl ResumeGuard {
    fn stop(peer: PeerProcess) -> io::Result<Self> {
        peer.signal(libc::SIGSTOP)?;
        let guard = Self { peer, armed: true };
        guard.wait_until_stopped()?;
        Ok(guard)
    }

    fn terminate(&mut self) -> io::Result<()> {
        self.peer.signal(libc::SIGTERM)?;
        self.peer.signal(libc::SIGCONT)?;
        self.armed = false;
        Ok(())
    }

    fn wait_until_stopped(&self) -> io::Result<()> {
        for _ in 0..50 {
            let status = std::fs::read_to_string(format!("/proc/{}/status", self.peer.pid))?;
            if status
                .lines()
                .find(|line| line.starts_with("State:"))
                .is_some_and(|line| line.contains("\tT") || line.contains("\tt"))
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "supervisor did not stop for active-work inspection",
        ))
    }
}

#[cfg(target_os = "linux")]
impl Drop for ResumeGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.peer.signal(libc::SIGCONT);
        }
    }
}

#[cfg(target_os = "linux")]
fn has_live_children(pid: libc::pid_t) -> io::Result<bool> {
    let task_root = format!("/proc/{pid}/task");
    for task in std::fs::read_dir(task_root)? {
        let children = std::fs::read_to_string(task?.path().join("children"))?;
        for child in children.split_whitespace() {
            let Ok(child_pid) = child.parse::<libc::pid_t>() else {
                continue;
            };
            match child_state(child_pid) {
                Ok('Z') => {}
                Ok(_) => return Ok(true),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn child_state(pid: libc::pid_t) -> io::Result<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    stat.rsplit_once(") ")
        .and_then(|(_, suffix)| suffix.chars().next())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid child process stat"))
}

#[cfg(target_os = "linux")]
fn verified_peer_pid(stream: &UnixStream) -> io::Result<libc::pid_t> {
    use std::os::fd::AsRawFd;

    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if credentials.uid != unsafe { libc::geteuid() } || credentials.pid <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor process ownership could not be verified",
        ));
    }
    Ok(credentials.pid)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn verified_peer_pid(_stream: &UnixStream) -> io::Result<libc::pid_t> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "verified supervisor takeover is supported on Linux",
    ))
}

#[cfg(not(unix))]
pub fn prepare_supervisor(_socket_path: &Path) -> io::Result<SupervisorPreparation> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the remote agent supervisor requires Unix-domain sockets",
    ))
}

#[cfg(all(test, target_os = "linux"))]
#[path = "prepare_tests.rs"]
mod tests;
