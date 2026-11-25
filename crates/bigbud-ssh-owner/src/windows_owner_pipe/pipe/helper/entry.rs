//! Standalone bootstrap. The environment carries a locator and a one-use
//! token, not a password or trusted PID. The native process handle must be
//! explicitly inherited by the isolated launch and its askpass child.

use super::{ExpectedPipePeer, PipeName, rejected, reply};
use std::{
    ffi::OsStr,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    },
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        NTSTATUS, STATUS_SUCCESS,
    },
    Storage::FileSystem::{SYNCHRONIZE, WriteFile},
    System::{
        IO::IO_STATUS_BLOCK,
        Pipes::{
            GetNamedPipeInfo, GetNamedPipeServerProcessId, PIPE_NOWAIT, PIPE_SERVER_END,
            SetNamedPipeHandleState,
        },
        Threading::{GetCurrentProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

const BOOTSTRAP_ENV: &str = "BIGBUD_SSH_PASSWORD_HELPER_V1";
const PROCESS_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;

// Kept local rather than expanding the crate's windows-sys feature surface.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> HANDLE;
}

// FileModeInformation reads flags from the local file object, not pipe data.
const FILE_MODE_INFORMATION_CLASS: i32 = 16;
const SYNCHRONOUS_IO: u32 = 0x10 | 0x20; // ALERT | NONALERT

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationFile(
        file: HANDLE,
        status: *mut IO_STATUS_BLOCK,
        info: *mut u32,
        length: u32,
        class: i32,
    ) -> NTSTATUS;
}

/// Bootstrap for one *dedicated* SSH launch, not an ambient environment
/// setting. Put only `owner_handle()` (plus necessary stdio) in the explicit
/// Windows inheritance allowlist. Close this copy as soon as spawn completes.
/// A launcher must separately qualify helper inheritance through real inbox
/// SSH and arrange bounded, SSH-owned stdout before collecting a password.
#[must_use]
pub struct PasswordHelperBootstrap {
    owner: OwnedHandle,
    value: String,
}

impl PasswordHelperBootstrap {
    pub const ENV: &'static str = BOOTSTRAP_ENV;

    pub fn prepare(name: &PipeName, token: [u8; 16]) -> io::Result<Self> {
        // SAFETY: the pseudohandle names the current process; duplicate_process
        // requests only query and synchronize rights in this private copy.
        let owner = duplicate_process(unsafe { GetCurrentProcess() }, true)?;
        let value = format!(
            "{}:{:032x}:{:x}",
            name.as_str(),
            u128::from_be_bytes(token),
            owner.as_raw_handle() as usize,
        );
        Ok(Self { owner, value })
    }

    pub fn owner_handle(&self) -> BorrowedHandle<'_> {
        self.owner.as_handle()
    }

    pub fn env_value(&self) -> &str {
        &self.value
    }
}

/// Only the standalone helper should invoke this entry. The opaque prompt is
/// not parsed for authority. File, console, remote-address, malformed startup,
/// and blocking output modes are not supported.
#[doc(hidden)]
pub fn run_password_helper_prompt(prompt: &OsStr) -> io::Result<()> {
    const BUDGET: Duration = Duration::from_secs(2);
    let deadline = Instant::now().checked_add(BUDGET).ok_or_else(rejected)?;
    if prompt.is_empty() || prompt.encode_wide().take(4097).count() > 4096 {
        return Err(rejected());
    }
    let value = std::env::var(BOOTSTRAP_ENV).map_err(|_| rejected())?;
    let (name, token, raw) = parse_bootstrap(&value)?;
    let mut flags = 0;
    // SAFETY: a handle number is untrusted; Windows validates it and writes
    // only to the live stack slot. Never adopt/close the supplied number.
    if unsafe { GetHandleInformation(raw, &mut flags) } == 0 || flags & HANDLE_FLAG_INHERIT == 0 {
        return Err(rejected());
    }
    let inherited = duplicate_process(raw, false)?;
    let (owner, ssh) = ExpectedPipePeer::askpass_lineage(inherited.as_handle())?;
    let output = Output::from_stdout(&ssh)?;
    let left = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(rejected)?;
    reply::exchange_reply(&name, &owner, token, left, |line| {
        output.write(line, deadline)
    })
}

fn parse_bootstrap(value: &str) -> io::Result<(PipeName, [u8; 16], HANDLE)> {
    if value.len() > 128 {
        return Err(rejected());
    }
    let mut fields = value.split(':');
    let name = PipeName::parse(fields.next().ok_or_else(rejected)?)?;
    let token = fields.next().ok_or_else(rejected)?;
    let raw = fields.next().ok_or_else(rejected)?;
    let hex = |text: &str| text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if fields.next().is_some() || token.len() != 32 || !hex(token) || !hex(raw) {
        return Err(rejected());
    }
    let token = u128::from_str_radix(token, 16)
        .map_err(|_| rejected())?
        .to_be_bytes();
    let raw = usize::from_str_radix(raw, 16).map_err(|_| rejected())?;
    // Reject pseudohandles (including reserved negative numbers).
    if raw == 0 || raw > isize::MAX as usize {
        return Err(rejected());
    }
    Ok((name, token, raw as HANDLE))
}

fn duplicate_process(source: HANDLE, inherit: bool) -> io::Result<OwnedHandle> {
    let mut raw = ptr::null_mut();
    // SAFETY: pseudo-handle parameters name this process. Windows validates
    // the source; only a successful duplication produces a fresh handle.
    let ok = unsafe {
        let current = GetCurrentProcess();
        DuplicateHandle(
            current,
            source,
            current,
            &mut raw,
            PROCESS_RIGHTS,
            inherit.into(),
            0,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful DuplicateHandle transferred ownership to us.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

struct Output<'a> {
    pipe: OwnedHandle,
    ssh: &'a ExpectedPipePeer,
}

impl<'a> Output<'a> {
    fn from_stdout(ssh: &'a ExpectedPipePeer) -> io::Result<Self> {
        // SAFETY: the process standard slot is consulted only; this entry owns
        // startup and neither closes nor replaces any standard slot.
        let raw = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(rejected());
        }
        // SAFETY: raw is the live standard slot in this single-threaded entry.
        let pipe = unsafe { BorrowedHandle::borrow_raw(raw) }.try_clone_to_owned()?;
        let mut flags = 0;
        // SAFETY: the handle is live and Windows validates that it is a pipe.
        let ok = unsafe {
            GetNamedPipeInfo(
                pipe.as_raw_handle(),
                &mut flags,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if ok == 0 || flags & PIPE_SERVER_END != 0 {
            return Err(rejected());
        }
        let output = Self { pipe, ssh };
        output.verify()?;
        require_synchronous(&output.pipe)?;
        // No plaintext may be read before demonstrating a nonblocking write
        // end. If inbox creates an incompatible handle, remain unsupported.
        let mode = PIPE_NOWAIT;
        // SAFETY: verified private client-side pipe and live read-only mode pointer.
        let ok = unsafe {
            SetNamedPipeHandleState(output.pipe.as_raw_handle(), &mode, ptr::null(), ptr::null())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(output)
    }

    fn verify(&self) -> io::Result<()> {
        self.ssh.verify(|| {
            let mut pid = 0;
            // SAFETY: retained pipe and valid kernel PID output pointer.
            let ok = unsafe { GetNamedPipeServerProcessId(self.pipe.as_raw_handle(), &mut pid) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(pid)
            }
        })
    }

    fn write(self, line: &[u8], deadline: Instant) -> io::Result<()> {
        self.verify()?;
        if Instant::now() >= deadline {
            return Err(rejected());
        }
        let mut written = 0;
        // SAFETY: the bounded, zeroizing line lives through this single
        // nonblocking synchronous write; no stdout buffering or retry.
        let ok = unsafe {
            WriteFile(
                self.pipe.as_raw_handle(),
                line.as_ptr(),
                line.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if ok == 0 || written as usize != line.len() {
            return Err(rejected());
        }
        Ok(())
    }
}

fn require_synchronous(pipe: &OwnedHandle) -> io::Result<()> {
    let mut mode = 0;
    let mut iosb = IO_STATUS_BLOCK::default();
    // SAFETY: verified live pipe and valid writable buffers. FileModeInformation
    // is filled directly from the file object and does not submit pending I/O.
    let status = unsafe {
        NtQueryInformationFile(
            pipe.as_raw_handle(),
            &mut iosb,
            &mut mode,
            size_of::<u32>() as u32,
            FILE_MODE_INFORMATION_CLASS,
        )
    };
    if status != STATUS_SUCCESS || mode & SYNCHRONOUS_IO == 0 {
        return Err(rejected());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_rejects_unbounded_remote_extra_and_pseudo_handle_inputs() {
        let pipe =
            PipeName::parse(r"\\.\pipe\bigbud-ssh-owner-1234567890abcdef1234567890abcdef").unwrap();
        let value = format!("{}:{:032x}:a0", pipe.as_str(), 1);
        assert!(parse_bootstrap(&value).is_ok());
        assert!(parse_bootstrap(&format!("{value}:extra")).is_err());
        assert!(parse_bootstrap(&value.replace(r"\\.", r"\\remote")).is_err());
        assert!(parse_bootstrap(&value.replace(":a0", ":0")).is_err());
        assert!(parse_bootstrap(&value.replace(":a0", &format!(":{:x}", usize::MAX))).is_err());
        assert!(parse_bootstrap(&format!("{value}{}", "0".repeat(128))).is_err());
    }
}
