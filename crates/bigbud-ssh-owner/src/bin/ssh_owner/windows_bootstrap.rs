//! One-shot Windows picker proof bootstrap over inherited private byte pipes.
//!
//! A trusted dispatcher starts this child with fresh, private byte pipes for
//! stdin/stdout and retains the spawned child's process handle. All stdio
//! records below use the existing 4-byte big-endian SSH-owner frame length.
//! These records are private launch data, not named-pipe protocol messages.
//!
//! 1. Dispatcher writes its own PID (4-byte little-endian) to child stdin.
//! 2. Child pins that process before publishing an endpoint. It sends one
//!    stdout frame: 32 fresh random bytes followed by the ASCII pipe name.
//! 3. Dispatcher parses the name and connects using `connect` with an
//!    `ExpectedPipePeer` from its retained child handle. It keeps the pipe
//!    open and returns the 32 bytes in a stdin frame, never on the named pipe.
//! 4. Child admits only the kernel-verified dispatcher and checks the nonce
//!    before handing off the endpoint. Keep stdin open through the exchange.
//!    Neither stdio stream carries picker requests. No reconnect, discovered
//!    PID, or caller-supplied pipe name.
//!
//! `--windows-pipe-bootstrap-only` closes after the handoff. The separate
//! `--windows-picker-proof` fixture runs the v1 picker protocol on that exact
//! connection. Neither mode is the normal launcher or a release path.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Read, Write},
    os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    ptr, thread,
    time::{Duration, Instant},
};

use bigbud_ssh_owner::{
    framing::Endpoint,
    windows_owner_pipe::{ExpectedPipePeer, OwnerPipe, VerifiedPipe},
};
use windows_sys::Win32::{
    Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation},
    Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
    Storage::FileSystem::SYNCHRONIZE,
    System::{
        Pipes::{GetNamedPipeInfo, PIPE_TYPE_MESSAGE, PeekNamedPipe},
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

const TIMEOUT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(10);
pub(super) const NONCE_LEN: usize = 32;

use crate::{RunResult, Token, windows_picker::platform::Fixture};

pub(super) fn require_proof_opt_in() -> io::Result<()> {
    if env::var_os("BIGBUD_SSH_OWNER_PICKER_PROOF").as_deref() != Some(OsStr::new("1")) {
        return Err(invalid_record());
    }
    Ok(())
}

pub(super) fn run(mode: Option<&str>, mut args: impl Iterator<Item = OsString>) -> RunResult<()> {
    require_proof_opt_in()?;
    let fixture = match mode {
        Some("--windows-pipe-bootstrap-only") if args.next().is_none() => None,
        Some("--windows-picker-proof") => Some(Fixture::parse(args)?),
        _ => return Err(invalid_record().into()),
    };
    let (input, output) = inherited_streams()?;
    with_verified_dispatcher(input, output, |pipe| match fixture {
        Some(fixture) => fixture.serve(pipe),
        None => Ok(()),
    })
}

pub(super) fn inherited_streams() -> io::Result<(File, File)> {
    let input = io::stdin();
    let output = io::stdout();
    Ok((
        private_pipe(input.as_handle())?,
        private_pipe(output.as_handle())?,
    ))
}

fn private_pipe(handle: BorrowedHandle<'_>) -> io::Result<File> {
    require_byte_pipe(handle)?;
    // SAFETY: this live stdio handle is borrowed exclusively for configuration
    // at startup. Clear inheritance on the original, not just the duplicate,
    // so CreateProcess cannot pass the private stream to a descendant.
    if unsafe { SetHandleInformation(handle.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Use an unbuffered view: read-ahead would hide pending bytes from PeekNamedPipe.
    Ok(File::from(handle.try_clone_to_owned()?))
}

/// Establish a one-shot endpoint whose peer is pinned for the full callback.
/// The caller supplies fresh, exclusively held byte pipes: in particular the
/// small stdout record must fit in an empty pipe without waiting for a read.
/// Do not expose the dispatcher PID or nonce to named-pipe protocol code.
fn with_verified_dispatcher<T, E: From<io::Error>>(
    mut input: File,
    mut output: File,
    serve: impl FnOnce(&mut VerifiedPipe) -> Result<T, E>,
) -> Result<T, E> {
    require_byte_pipe(input.as_handle())?;
    require_byte_pipe(output.as_handle())?;
    let start = Instant::now();
    let pid = u32::from_le_bytes(read_record(&mut input, start)?);
    let dispatcher = pin_dispatcher(pid)?;
    let listener = OwnerPipe::create()?;
    let nonce = random_token()?;
    let mut publication = Vec::from(nonce);
    publication.extend_from_slice(listener.name().as_str().as_bytes());
    remaining(start)?;
    Endpoint::Owner
        .write_frame(&mut output, &publication)
        .map_err(io::Error::other)?;
    output.flush()?;

    let mut pipe = listener.accept(&dispatcher, remaining(start)?)?;
    if read_record::<NONCE_LEN>(&mut input, start)? != nonce {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "picker bootstrap nonce rejected",
        )
        .into());
    }
    // Release the duplicate stdio handles before dispatch. Keep the peer
    // pinned until the callback returns and the verified pipe closes.
    drop((input, output));
    serve(&mut pipe)
}

fn pin_dispatcher(pid: u32) -> io::Result<ExpectedPipePeer> {
    if pid == 0 {
        return Err(invalid_record());
    }
    // SAFETY: query/synchronize only, no inheritance; a non-null result is owned.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcess transferred this live handle to us exactly once.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    ExpectedPipePeer::from_handle(process.as_handle())
}

pub(super) fn random_token() -> io::Result<Token> {
    let mut nonce = [0; NONCE_LEN];
    // SAFETY: null algorithm selects system RNG; the buffer fits the given size.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            nonce.as_mut_ptr(),
            NONCE_LEN as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other("picker bootstrap RNG unavailable"));
    }
    Ok(nonce)
}

fn require_byte_pipe(handle: BorrowedHandle<'_>) -> io::Result<()> {
    let mut flags = 0;
    // SAFETY: the handle is borrowed through this call; flags is a valid out
    // pointer and all omitted outputs are optional.
    let ok = unsafe {
        GetNamedPipeInfo(
            handle.as_raw_handle(),
            &mut flags,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & PIPE_TYPE_MESSAGE != 0 {
        return Err(invalid_record());
    }
    Ok(())
}

fn read_record<const N: usize>(
    input: &mut (impl Read + AsHandle),
    start: Instant,
) -> io::Result<[u8; N]> {
    let mut header = [0; 4];
    read_available(input, &mut header, start)?;
    let length = Endpoint::Owner
        .decode_inbound_header(header)
        .map_err(io::Error::other)?;
    if length != N {
        return Err(invalid_record());
    }
    let mut payload = [0; N];
    read_available(input, &mut payload, start)?;
    remaining(start)?;
    Ok(payload)
}

pub(super) fn read_available(
    input: &mut (impl Read + AsHandle),
    bytes: &mut [u8],
    start: Instant,
) -> io::Result<()> {
    loop {
        remaining(start)?;
        if available_bytes(input.as_handle())? >= bytes.len() {
            return input.read_exact(bytes);
        }
        thread::sleep(remaining(start)?.min(POLL));
    }
}

pub(super) fn available_bytes(handle: BorrowedHandle<'_>) -> io::Result<usize> {
    let mut available = 0;
    // SAFETY: live borrowed byte pipe, sole reader, and valid count output;
    // no buffer is read or consumed by this call.
    let ok = unsafe {
        PeekNamedPipe(
            handle.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available as usize)
}

pub(super) fn remaining(start: Instant) -> io::Result<Duration> {
    TIMEOUT
        .checked_sub(start.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "picker bootstrap deadline expired"))
}

fn invalid_record() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid picker bootstrap")
}

#[cfg(test)]
#[path = "windows_bootstrap.test.rs"]
mod tests;
