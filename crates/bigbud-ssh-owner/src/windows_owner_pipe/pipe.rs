use super::{
    ExpectedPipePeer, PipeName, policy::within, process::owned, security::owner_descriptor,
};
use crate::framing::Endpoint;
use overlapped::{Deadline, Operation};

mod frame;
pub use frame::PipeReadiness;
pub(crate) mod helper;
mod overlapped;
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::ERROR_PIPE_BUSY,
    Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ,
        FILE_WRITE_DATA, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT,
    },
    System::Pipes::{
        CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    },
};

/// A single, exclusive owner endpoint. No fallback to an existing instance.
#[must_use]
pub struct OwnerPipe {
    name: PipeName,
    handle: OwnedHandle,
}

/// Retains a connected, process-verified endpoint until drop. Not an authenticated
/// SSH request and not permission to read or release any secret.
#[must_use]
pub struct VerifiedPipe {
    handle: Option<OwnedHandle>,
    endpoint: Endpoint,
}

pub(crate) fn random_token() -> io::Result<[u8; 16]> {
    let mut random = [0u8; 16];
    // SAFETY: null algorithm uses the system-preferred RNG; output fits the supplied size.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            random.as_mut_ptr(),
            random.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other("Windows SSH owner RNG unavailable"));
    }
    Ok(random)
}

impl OwnerPipe {
    /// Binds a fresh per-session name using Windows' system RNG.
    pub fn create() -> io::Result<Self> {
        Self::bind(PipeName::from_random_bytes(random_token()?))
    }

    fn bind(name: PipeName) -> io::Result<Self> {
        let wide = wide_name(&name);
        let descriptor = owner_descriptor()?;
        let attributes = descriptor.attributes();
        // SAFETY: local NUL-terminated name and owner-only descriptor stay live;
        // the returned handle, if valid, is newly owned and non-inheritable.
        let handle = unsafe {
            owned(CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                2000,
                &attributes,
            ))
        }?;
        Ok(Self { name, handle })
    }

    pub fn name(&self) -> &PipeName {
        &self.name
    }

    /// Wait up to `timeout` (at most two seconds) for the expected client. A
    /// failed accept consumes the listener so a rejected peer cannot stay bound.
    pub fn accept(
        self,
        expected_client: &ExpectedPipePeer,
        timeout: Duration,
    ) -> io::Result<VerifiedPipe> {
        let deadline = Deadline::new(timeout)?;
        Operation::new(&self.handle, &deadline)?.accept()?;
        expected_client.verify(|| peer_pid(&self.handle, PeerEnd::Client))?;
        deadline.remaining()?;
        Ok(VerifiedPipe {
            handle: Some(self.handle),
            endpoint: Endpoint::Owner,
        })
    }
}

/// Opens only the local namespace, verifies the expected server before yielding
/// an endpoint, and retries only busy instances, for at most two seconds.
pub fn connect(
    name: &PipeName,
    expected_server: &ExpectedPipePeer,
    timeout: Duration,
) -> io::Result<VerifiedPipe> {
    let wide = wide_name(name);
    let start = Instant::now();
    within(
        timeout,
        || start.elapsed(),
        thread::sleep,
        || {
            // SAFETY: validated local name and no inherited handle. Identification
            // QoS prevents a squatting server from impersonating this caller.
            // FILE_WRITE_DATA deliberately omits FILE_CREATE_PIPE_INSTANCE.
            let handle = unsafe {
                owned(CreateFileW(
                    wide.as_ptr(),
                    FILE_GENERIC_READ | FILE_WRITE_DATA,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                ))
            };
            match handle {
                Ok(handle) => {
                    expected_server.verify(|| peer_pid(&handle, PeerEnd::Server))?;
                    Ok(Some(VerifiedPipe {
                        handle: Some(handle),
                        endpoint: Endpoint::Client,
                    }))
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => Ok(None),
                Err(error) => Err(error),
            }
        },
    )
}

#[derive(Clone, Copy)]
enum PeerEnd {
    Client,
    Server,
}

fn peer_pid(handle: &OwnedHandle, end: PeerEnd) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: live connected pipe handle and valid output for the kernel PID query.
    let ok = unsafe {
        match end {
            PeerEnd::Client => GetNamedPipeClientProcessId(handle.as_raw_handle(), &mut pid),
            PeerEnd::Server => GetNamedPipeServerProcessId(handle.as_raw_handle(), &mut pid),
        }
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(pid)
    }
}

fn wide_name(name: &PipeName) -> Vec<u16> {
    name.as_str().encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests;
