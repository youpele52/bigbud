use std::io::{self, BufReader, BufWriter, Write};
use std::path::Path;

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, write_frame,
};

use crate::AgentSession;
use crate::identity;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
fn request_shutdown_with_mode(socket_path: &Path, interrupt_owned_work: bool) -> io::Result<bool> {
    verify_control_socket(socket_path)?;
    let stream = UnixStream::connect(socket_path)?;
    if interrupt_owned_work {
        verify_peer_process(&stream)?;
    }
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    let mut writer = BufWriter::new(stream);
    write_frame(
        &mut writer,
        &bigbud_protocol::v1::Frame {
            payload: Some(bigbud_protocol::v1::frame::Payload::ClientHello(
                bigbud_protocol::v1::ClientHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    client_instance_id: format!("retirement-{}", std::process::id()),
                    connection_id: format!("retirement-{}", std::process::id()),
                    server_nonce: format!("retirement-{}", std::process::id()),
                    max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
                },
            )),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .map_err(io::Error::other)?;
    writer.flush()?;
    let hello = read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES)
        .map_err(io::Error::other)?
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "supervisor closed at hello")
        })?;
    let Some(bigbud_protocol::v1::frame::Payload::AgentHello(hello)) = hello.payload else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid supervisor hello",
        ));
    };
    if hello.agent_version != identity::build_version()
        || hello.build_digest != identity::build_digest()
        || hello.agent_epoch.is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor identity does not match the verified managed binary",
        ));
    }
    if interrupt_owned_work
        && !hello
            .capabilities
            .iter()
            .any(|capability| capability.name == "supervisor.restart" && capability.major == 1)
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "supervisor does not advertise verified restart capability",
        ));
    }
    let request_id = format!("retire-{}", std::process::id());
    write_frame(
        &mut writer,
        &bigbud_protocol::v1::Frame {
            payload: Some(
                bigbud_protocol::v1::frame::Payload::SupervisorShutdownRequest(
                    bigbud_protocol::v1::SupervisorShutdownRequest {
                        request_id: request_id.clone(),
                        expected_agent_epoch: hello.agent_epoch,
                        expected_build_digest: identity::build_digest().to_owned(),
                        interrupt_owned_work,
                    },
                ),
            ),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .map_err(io::Error::other)?;
    writer.flush()?;
    let response = read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES)
        .map_err(io::Error::other)?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "supervisor closed at shutdown",
            )
        })?;
    match response.payload {
        Some(bigbud_protocol::v1::frame::Payload::SupervisorShutdownResponse(response))
            if response.request_id == request_id =>
        {
            Ok(response.accepted && response.terminal)
        }
        Some(bigbud_protocol::v1::frame::Payload::ProtocolError(error)) => {
            Err(io::Error::other(error.message))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid shutdown response",
        )),
    }
}

#[cfg(unix)]
pub fn request_shutdown(socket_path: &Path) -> io::Result<bool> {
    request_shutdown_with_mode(socket_path, false)
}

#[cfg(unix)]
pub fn request_restart(socket_path: &Path) -> io::Result<bool> {
    request_shutdown_with_mode(socket_path, true)
}

#[allow(clippy::exit)]
pub(crate) fn exit_supervisor() -> ! {
    std::process::exit(0)
}

pub fn shutdown_response(
    session: &mut AgentSession,
    request: bigbud_protocol::v1::SupervisorShutdownRequest,
    active_watchers: bool,
    active_subscribers: bool,
) -> (bigbud_protocol::v1::Frame, bool) {
    let identity_matches = session.retirement_identity_matches(
        &request.expected_agent_epoch,
        &request.expected_build_digest,
    );
    let restart_available = !request.interrupt_owned_work || session.is_accepting_work();
    let evidence = if request.interrupt_owned_work && identity_matches && restart_available {
        Some(session.interrupt_owned_work_for_restart())
    } else {
        None
    };
    let idle = request.interrupt_owned_work
        || (!active_watchers && !active_subscribers && session.is_idle_for_retirement());
    let accepted = !request.request_id.is_empty()
        && identity_matches
        && restart_available
        && idle
        && evidence.is_none_or(|evidence| evidence.pty_failures == 0);
    let detail = if accepted {
        if request.interrupt_owned_work {
            "restart-accepted-owned-shutdown-requested"
        } else {
            "shutdown-accepted"
        }
    } else if !identity_matches {
        "supervisor-identity-mismatch"
    } else if !restart_available {
        "restart-already-requested"
    } else if !idle {
        "supervisor-not-idle"
    } else {
        "invalid-shutdown-request"
    };
    (
        bigbud_protocol::v1::Frame {
            payload: Some(
                bigbud_protocol::v1::frame::Payload::SupervisorShutdownResponse(
                    bigbud_protocol::v1::SupervisorShutdownResponse {
                        request_id: request.request_id,
                        accepted,
                        terminal: true,
                        detail: detail.to_owned(),
                    },
                ),
            ),
        },
        accepted,
    )
}

#[cfg(unix)]
fn verify_control_socket(socket_path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let metadata = std::fs::symlink_metadata(socket_path)?;
    // SAFETY: geteuid has no pointers or borrowed memory and only reads the
    // effective identity of this process for the socket ownership check.
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor control socket ownership or permissions are invalid",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_peer_process(stream: &UnixStream) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: credentials points to a fully initialized ucred value and the
    // length matches its allocation; getsockopt writes only that value.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    // SAFETY: geteuid has no pointers or borrowed memory; it is the identity
    // used to validate the peer credentials returned above.
    if result != 0 || credentials.uid != unsafe { libc::geteuid() } || credentials.pid <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor process ownership could not be verified",
        ));
    }
    let expected = std::fs::canonicalize(std::env::current_exe()?)?;
    let actual = std::fs::canonicalize(format!("/proc/{}/exe", credentials.pid))?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor executable identity does not match",
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn verify_peer_process(_stream: &UnixStream) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "verified supervisor process control is supported on Linux",
    ))
}

#[cfg(not(unix))]
pub fn request_shutdown(_socket_path: &Path) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "managed supervisor shutdown requires Unix-domain sockets",
    ))
}

#[cfg(not(unix))]
pub fn request_restart(_socket_path: &Path) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "managed supervisor restart requires Unix-domain sockets",
    ))
}
