//! Proof-only bridge from backend-owned inherited byte streams to one verified owner pipe.
//!
//! The backend supplies the existing picker fixture arguments, not a PID, pipe
//! name, or executable override. Stdio carries only opaque v1 frames, including
//! the storage exchanges; only the bridge's private child pipes carry launch data.

mod output;

use std::{
    env,
    ffi::OsString,
    fs::File,
    io::{self, Read},
    os::windows::{
        io::{AsHandle, AsRawHandle},
        process::CommandExt,
    },
    process::{self, Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use bigbud_ssh_owner::{
    framing::Endpoint,
    windows_owner_pipe::{ExpectedPipePeer, PipeName, PipeReadiness, VerifiedPipe, connect},
};
use prost::Message;
use windows_sys::Win32::{
    Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::Threading::{CREATE_NO_WINDOW, WaitForSingleObject},
};

use crate::{
    RunResult, Token,
    v1::{self, frame::Payload, reply::Outcome},
    windows_bootstrap::{self as bootstrap, NONCE_LEN},
    windows_picker::platform::Fixture,
};

const MAX_PUBLICATION: usize = 256;
const POLL: Duration = Duration::from_millis(10);
const FRAME_TIMEOUT: Duration = Duration::from_secs(2);
// An approved operation can spend up to 10 seconds in the Windows transport.
// Don't apply the partial-frame budget to the owner's execution time.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
const REAP_MS: u32 = 250;
const ACTIVE_REAP_MS: u32 = 13_000;

pub(super) fn run(args: impl Iterator<Item = OsString>) -> RunResult<()> {
    bootstrap::require_proof_opt_in()?;
    let args: Vec<_> = args.take(8).collect();
    Fixture::parse(args.iter().cloned())?;
    let (mut input, output) = bootstrap::inherited_streams()?;
    let mut output = output::Writer::start(output)?;

    let result = launch(args, &mut input, &mut output);
    let stopped = output.stop();
    result.and(stopped)
}

fn launch(args: Vec<OsString>, input: &mut File, output: &mut output::Writer) -> RunResult<()> {
    // current_exe identifies this executable, never a PATH lookup or a separately
    // configured image. Stderr must never be mixed with the backend byte stream.
    let mut owner = Command::new(env::current_exe()?)
        .arg("--windows-picker-proof")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    let mut owner_busy = false;
    let result = (|| {
        let (mut pipe, _bootstrap_input, _bootstrap_output) = connect_owner(&mut owner)?;
        relay(input, output, &mut pipe, &mut owner_busy)
        // The pipe closes before the process wait, so an idle owner can exit
        // and an active owner can finish its bounded transport cleanup.
    })();
    let stopped = reap(&mut owner, owner_busy);
    result.and(stopped.map_err(Into::into))
}

fn connect_owner(owner: &mut Child) -> RunResult<(VerifiedPipe, ChildStdin, ChildStdout)> {
    let mut input = owner.stdin.take().ok_or_else(invalid_publication)?;
    let mut output = owner.stdout.take().ok_or_else(invalid_publication)?;
    let peer = ExpectedPipePeer::from_handle(owner.as_handle())?;
    let start = Instant::now();
    Endpoint::Client.write_frame(&mut input, &process::id().to_le_bytes())?;
    let (nonce, name) = read_publication(&mut output, start)?;
    let pipe = connect(&name, &peer, bootstrap::remaining(start)?)?;
    bootstrap::remaining(start)?;
    // Child stdin is fresh and contains at most the small bootstrap records.
    // Keep it open through the complete echo; never expose the nonce to v1.
    Endpoint::Client.write_frame(&mut input, &nonce)?;
    bootstrap::remaining(start)?;
    Ok((pipe, input, output))
}

fn read_publication(
    input: &mut (impl Read + AsHandle),
    start: Instant,
) -> RunResult<(Token, PipeName)> {
    let mut header = [0; 4];
    bootstrap::read_available(input, &mut header, start)?;
    let size = Endpoint::Client.decode_inbound_header(header)?;
    let mut record = [0; MAX_PUBLICATION];
    let record = record.get_mut(..size).ok_or_else(invalid_publication)?;
    bootstrap::read_available(input, record, start)?;
    Ok(parse_publication(record)?)
}

fn parse_publication(record: &[u8]) -> io::Result<(Token, PipeName)> {
    let (nonce, name) = record
        .split_at_checked(NONCE_LEN)
        .ok_or_else(invalid_publication)?;
    let nonce = nonce.try_into().map_err(|_| invalid_publication())?;
    let name = std::str::from_utf8(name).map_err(|_| invalid_publication())?;
    Ok((nonce, PipeName::parse(name)?))
}

fn invalid_publication() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid owner publication")
}

fn relay(
    input: &mut File,
    output: &mut output::Writer,
    pipe: &mut VerifiedPipe,
    owner_busy: &mut bool,
) -> RunResult<()> {
    loop {
        match backend_state(input)? {
            BackendState::Closed => return Ok(()),
            BackendState::Idle => match pipe.wait_for_input(POLL)? {
                PipeReadiness::Idle => continue,
                PipeReadiness::Closed => return Err(owner_closed().into()),
                PipeReadiness::Ready => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unsolicited owner frame",
                    )
                    .into());
                }
            },
            BackendState::Ready(_) => {}
        }
        let mut reader = RequestReader {
            input,
            start: Instant::now(),
        };
        let Some(request) = Endpoint::Owner.read_frame(&mut reader)? else {
            return Ok(());
        };
        if let Some(reply) = password_refusal(&request) {
            // Refused at the Windows boundary before any owner dispatch.
            output.send(reply)?;
            continue;
        }
        *owner_busy = true;
        pipe.write_frame(&request, FRAME_TIMEOUT)?;
        let Some(reply) = read_reply(input, pipe)? else {
            return Ok(());
        };
        *owner_busy = false;
        output.send(reply)?;
    }
}

fn password_refusal(frame_bytes: &[u8]) -> Option<Vec<u8>> {
    let Ok(v1::Frame {
        payload: Some(Payload::Request(request)),
    }) = v1::Frame::decode(frame_bytes)
    else {
        return None;
    };
    let operation = request.operation.as_ref()?;
    let code = crate::windows_picker::password_denial(operation)?;
    Some(
        v1::Frame {
            payload: Some(Payload::Reply(v1::Reply {
                request_id: request.request_id,
                owner_epoch: request.owner_epoch,
                target_generation: request.target_generation,
                outcome: Some(Outcome::Error(v1::Error {
                    code: code.into(),
                    jump_failure: None,
                })),
            })),
        }
        .encode_to_vec(),
    )
}

fn read_reply(input: &File, pipe: &mut VerifiedPipe) -> RunResult<Option<Vec<u8>>> {
    let deadline = Instant::now() + REPLY_TIMEOUT;
    loop {
        if matches!(backend_state(input)?, BackendState::Closed) {
            return Ok(None);
        }
        let left = time_left(deadline)?;
        match pipe.wait_for_input(left.min(POLL))? {
            PipeReadiness::Idle => continue,
            PipeReadiness::Closed => return Err(owner_closed().into()),
            PipeReadiness::Ready => {
                let timeout = time_left(deadline)?.min(FRAME_TIMEOUT);
                return pipe
                    .read_frame(timeout)?
                    .map(Some)
                    .ok_or_else(|| owner_closed().into());
            }
        }
    }
}

fn owner_closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "verified owner pipe closed")
}

fn time_left(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "picker dispatcher deadline expired",
            )
        })
}

struct RequestReader<'a> {
    input: &'a mut File,
    start: Instant,
}

impl Read for RequestReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let deadline = self.start + FRAME_TIMEOUT;
        loop {
            let left = time_left(deadline)?;
            match backend_state(self.input)? {
                BackendState::Closed => return Ok(0),
                BackendState::Idle => thread::sleep(left.min(POLL)),
                BackendState::Ready(count) => {
                    // No other reader shares this handle. Consume only queued
                    // bytes; a request can be larger than the pipe buffer.
                    let count = count.min(bytes.len());
                    return self
                        .input
                        .read(bytes.get_mut(..count).ok_or_else(invalid_publication)?);
                }
            }
        }
    }
}

enum BackendState {
    Closed,
    Idle,
    Ready(usize),
}

fn backend_state(input: &File) -> io::Result<BackendState> {
    match bootstrap::available_bytes(input.as_handle()) {
        Ok(0) => Ok(BackendState::Idle),
        Ok(count) => Ok(BackendState::Ready(count)),
        Err(error)
            if matches!(
                error.raw_os_error().map(|code| code as u32),
                Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
            ) =>
        {
            Ok(BackendState::Closed)
        }
        Err(error) => Err(error),
    }
}

fn reap(owner: &mut Child, owner_busy: bool) -> io::Result<()> {
    let grace = if owner_busy { ACTIVE_REAP_MS } else { REAP_MS };
    let graceful = wait_for_exit(owner, grace);
    if matches!(graceful, Ok(true)) {
        return Ok(());
    }
    let killed = owner.kill();
    // Exit may have raced the kill. Only the retained handle proves completion.
    if wait_for_exit(owner, REAP_MS)? {
        return Ok(());
    }
    killed?;
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "picker owner did not exit",
    ))
}

fn wait_for_exit(owner: &Child, timeout_ms: u32) -> io::Result<bool> {
    // SAFETY: the Child owns the live process handle through this bounded wait.
    match unsafe { WaitForSingleObject(owner.as_raw_handle(), timeout_ms) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(test)]
mod tests;
