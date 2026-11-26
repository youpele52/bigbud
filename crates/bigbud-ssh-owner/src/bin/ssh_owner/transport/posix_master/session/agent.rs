//! One long-lived owner-side mux session for a per-target agent proxy.
//!
//! The session rides the already-verified master's control stream: no second
//! SSH connection is dialled and no forwarding is requested. The remote command
//! is supplied by the owner, the local stdin/stdout/stderr endpoints are fresh
//! private pipes, and the control stream stays owned so a later close can read
//! the explicit `EXIT_MESSAGE` for this exact session.

use super::{ErrorCode, LOST, UnixStream, probe, stdio, words};
use std::io::{self, PipeReader, PipeWriter, Read};
use std::os::fd::AsRawFd;
use std::time::Instant;

const NEW_SESSION: u32 = 0x1000_0002;
const EXIT_MESSAGE: u32 = 0x8000_0004;
const REQUEST_ID: u32 = 2; // ALIVE_CHECK already used request 1 on this stream.
const SESSION_OPENED: u32 = 0x8000_0006;
const MAX_COMMAND: usize = 64 * 1024;

/// The owner side of one mux session. `control` carries the mux messages for
/// this session only; `input` writes the remote stdin, while `output` and
/// `stderr` read the remote stdout and stderr independently.
pub(crate) struct AgentIo {
    pub(crate) control: UnixStream,
    pub(crate) input: PipeWriter,
    pub(crate) output: PipeReader,
    pub(crate) stderr: PipeReader,
}

/// The explicit remote exit carried by `EXIT_MESSAGE`. A signal death arrives as
/// a negative status and is never reported as a numeric process exit code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RemoteExit {
    pub(crate) code: Option<i32>,
    pub(crate) signal: Option<i32>,
}

impl RemoteExit {
    fn from_status(status: &[u8; 4]) -> Self {
        let raw = i32::from_be_bytes(*status);
        if raw < 0 {
            Self {
                code: None,
                signal: Some(raw.saturating_neg()),
            }
        } else {
            Self {
                code: Some(raw),
                signal: None,
            }
        }
    }
}

/// Ask the verified master for one new session. The request carries no tty,
/// X11, agent, subsystem, term or environment, and exactly the owner command.
pub(crate) fn open(
    control: UnixStream,
    command: &str,
    deadline: Instant,
) -> Result<AgentIo, ErrorCode> {
    if command.is_empty() || command.len() > MAX_COMMAND || command.contains('\0') {
        return Err(ErrorCode::InvalidOperands);
    }
    let length = u32::try_from(command.len()).map_err(|_| ErrorCode::InvalidOperands)?;
    // NEW_SESSION with no tty, X11, agent, subsystem, term or environment.
    let fields = [NEW_SESSION, REQUEST_ID, 0, 0, 0, 0, 0, u32::MAX, 0, length];
    let header = std::mem::size_of_val(&fields);
    let mut frame = Vec::with_capacity(4 + header + command.len());
    frame.extend_from_slice(&(header as u32 + length).to_be_bytes());
    frame.extend(fields.into_iter().flat_map(u32::to_be_bytes));
    frame.extend_from_slice(command.as_bytes());
    let mut channel = &control;
    probe::write_with(&mut channel, &frame, deadline, None)?;

    let (remote_stdin, input) = io::pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let (output, remote_stdout) = io::pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let (stderr, remote_stderr) = io::pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    // Only the mux peer keeps these after the send; our copies must be dropped
    // so EOF on the owner pipes reflects only the remote process.
    stdio::send_fds(
        &control,
        [
            remote_stdin.as_raw_fd(),
            remote_stdout.as_raw_fd(),
            remote_stderr.as_raw_fd(),
        ],
        deadline,
        None,
    )?;
    drop(remote_stdin);
    drop(remote_stdout);
    drop(remote_stderr);

    let mut reply = [0; 16];
    let mut channel = &control;
    probe::read_with(&mut channel, &mut reply, deadline, None)?;
    let [reply_length, kind, request, _session] = words(&reply);
    if (reply_length, kind, request) != (12, SESSION_OPENED, REQUEST_ID) {
        return Err(LOST);
    }
    Ok(AgentIo {
        control,
        input,
        output,
        stderr,
    })
}

/// Read the explicit exit status for this session when the master has already
/// emitted it. `Ok(None)` means no complete final message is available yet; a
/// malformed or foreign message is a loss, never a guessed status.
pub(crate) fn read_exit(
    control: &mut UnixStream,
    packet: &mut [u8; 16],
    used: &mut usize,
) -> Result<Option<RemoteExit>, ErrorCode> {
    if *used == packet.len() {
        let [length, kind, request, _status] = words(packet);
        if (length, kind, request) != (12, EXIT_MESSAGE, REQUEST_ID) {
            return Err(LOST);
        }
        let status: [u8; 4] = packet
            .get(12..16)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(LOST)?;
        return Ok(Some(RemoteExit::from_status(&status)));
    }
    let target = packet.get_mut(*used..).ok_or(LOST)?;
    match control.read(target) {
        Ok(0) => Err(LOST),
        Ok(count) => {
            *used = used.saturating_add(count);
            Ok(None)
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(None),
        Err(_) => Err(LOST),
    }
}
