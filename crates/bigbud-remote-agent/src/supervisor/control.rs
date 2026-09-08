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
pub fn request_shutdown(socket_path: &Path) -> io::Result<bool> {
    let stream = UnixStream::connect(socket_path)?;
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
    let idle = !active_watchers && !active_subscribers && session.is_idle_for_retirement();
    let accepted = !request.request_id.is_empty() && identity_matches && idle;
    let detail = if accepted {
        "shutdown-accepted"
    } else if !identity_matches {
        "supervisor-identity-mismatch"
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

#[cfg(not(unix))]
pub fn request_shutdown(_socket_path: &Path) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "managed supervisor shutdown requires Unix-domain sockets",
    ))
}
