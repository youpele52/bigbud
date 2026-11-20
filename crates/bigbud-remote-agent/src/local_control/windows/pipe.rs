use super::super::protocol::{Endpoint, MAX_CLIENTS, PIPE_PREFIX, pipe_name};
use super::io::{operation, owned, pending};
use crate::inspect_local::control;
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::*,
    System::{Pipes::*, Threading::*},
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
pub(super) fn create(name: &str, first: bool) -> io::Result<OwnedHandle> {
    pipe_name(name)?;
    let descriptor = control::pipe_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(name);
    // SAFETY: name/explicit owner-only descriptor are live, non-inherited handles, remote clients rejected.
    owned(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            (MAX_CLIENTS + 1) as u32,
            65536,
            65536,
            5000,
            &attributes,
        )
    })
}
pub(super) fn accept(pipe: &OwnedHandle, stopped: &AtomicBool) -> io::Result<()> {
    operation(
        pipe.as_raw_handle(),
        Duration::from_secs(5),
        stopped,
        |overlapped| {
            // SAFETY: pipe and OVERLAPPED remain valid through completion/cancellation.
            let result = unsafe { ConnectNamedPipe(pipe.as_raw_handle(), overlapped) };
            if result == 0
                && io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32)
            {
                return Ok(false);
            }
            pending(result)
        },
    )
    .map(|_| ())
}
pub(super) fn started(process: HANDLE) -> io::Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: query-only live process handle and valid output pointers.
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}
pub(super) fn self_endpoint(name: &str, backend: &str) -> io::Result<Endpoint> {
    // SAFETY: pseudo handle is borrowed only for query; never closed.
    let started = started(unsafe { GetCurrentProcess() })?;
    let endpoint = Endpoint {
        pipe: pipe_name(name)?.to_string(),
        pid: std::process::id(),
        started,
        backend: backend.to_string(),
    };
    Endpoint::parse(&endpoint.encode())
}
pub(super) fn connect(endpoint: &Endpoint) -> io::Result<OwnedHandle> {
    let name = wide(pipe_name(&endpoint.pipe)?);
    let began = Instant::now();
    let pipe = loop {
        // SAFETY: non-inherited overlapped handle; IDENTIFICATION prevents a squatting server impersonating this client.
        let result = owned(unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        });
        match result {
            Ok(pipe) => break pipe,
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && began.elapsed() < Duration::from_secs(5) =>
            {
                // SAFETY: bounded wait for the exact validated name. Identity is checked after connecting.
                unsafe {
                    WaitNamedPipeW(name.as_ptr(), 100);
                }
            }
            Err(error) => return Err(error),
        }
    };
    let mut pid = 0;
    // SAFETY: connected handle and valid process-id output.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0
        || pid != endpoint.pid
    {
        return Err(io::Error::other("pipe server identity rejected"));
    }
    // SAFETY: query-only process handle for the connected server, never a process-control request.
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    if !control::same_account(process.as_raw_handle())?
        || started(process.as_raw_handle())? != endpoint.started
    {
        return Err(io::Error::other(
            "pipe server account or generation rejected",
        ));
    }
    Ok(pipe)
}
pub(super) fn nonce(name: &str) -> io::Result<&str> {
    pipe_name(name)?
        .strip_prefix(PIPE_PREFIX)
        .ok_or_else(|| io::Error::other("pipe namespace"))
}

/// Only positive process-exit or PID-reuse evidence permits replacing a stale endpoint.
pub(crate) fn prior_owner_dead(endpoint: &Endpoint) -> io::Result<bool> {
    // SAFETY: query/synchronize rights only; no termination or modification.
    let process = match owned(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            endpoint.pid,
        )
    }) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
            return Ok(true);
        }
        Err(error) => return Err(error),
    };
    if started(process.as_raw_handle())? != endpoint.started {
        return Ok(true);
    }
    // SAFETY: live owned process handle and zero-duration nonblocking query.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}
