use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::{ReadFile, WriteFile},
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Threading::{CreateEventW, WaitForSingleObject},
    },
};

pub(super) fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: caller transfers a newly-created non-null handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
/// Completion (including cancellation) is observed before stack OVERLAPPED or buffers disappear.
pub(super) fn operation(
    handle: HANDLE,
    timeout: Duration,
    stopped: &AtomicBool,
    start: impl FnOnce(*mut OVERLAPPED) -> io::Result<bool>,
) -> io::Result<u32> {
    // SAFETY: no name or security descriptor; private non-inherited event.
    let event = owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle(),
        ..Default::default()
    };
    if !start(&mut overlapped)? {
        return Ok(0);
    }
    let began = Instant::now();
    loop {
        // SAFETY: event and OVERLAPPED remain owned until completion is settled below.
        let wait = unsafe { WaitForSingleObject(event.as_raw_handle(), 100) };
        if wait == WAIT_OBJECT_0 {
            let mut transferred = 0;
            // SAFETY: live operation handle/OVERLAPPED and valid output storage.
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, 0) } == 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(transferred);
        }
        if wait == WAIT_FAILED || stopped.load(Ordering::Acquire) || began.elapsed() >= timeout {
            let error = if wait == WAIT_FAILED {
                io::Error::last_os_error()
            } else {
                io::Error::new(io::ErrorKind::TimedOut, "pipe operation ended")
            };
            // SAFETY: cancel this exact outstanding operation, then drain even when completion raced cancellation.
            unsafe {
                CancelIoEx(handle, &overlapped);
                let mut ignored = 0;
                GetOverlappedResult(handle, &overlapped, &mut ignored, 1);
            }
            return Err(error);
        }
    }
}
pub(super) fn pending(success: i32) -> io::Result<bool> {
    if success != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
        Ok(true)
    } else {
        Err(error)
    }
}
pub(super) fn read_line(
    handle: HANDLE,
    timeout: Duration,
    stopped: &AtomicBool,
) -> io::Result<Vec<u8>> {
    let began = Instant::now();
    let mut result = Vec::new();
    loop {
        let remaining = timeout
            .checked_sub(began.elapsed())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "pipe read deadline"))?;
        let mut bytes = [0u8; 4096];
        let count = operation(handle, remaining, stopped, |overlapped| {
            // SAFETY: buffer is pinned on this stack through operation completion/cancellation.
            pending(unsafe {
                ReadFile(
                    handle,
                    bytes.as_mut_ptr(),
                    bytes.len() as u32,
                    ptr::null_mut(),
                    overlapped,
                )
            })
        })? as usize;
        let chunk = bytes
            .get(..count)
            .ok_or_else(|| io::Error::other("read count rejected"))?;
        if chunk.is_empty() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed"));
        }
        if result.len() + chunk.len() > super::super::protocol::MAX_BYTES {
            return Err(io::Error::other("pipe frame bound"));
        }
        result.extend_from_slice(chunk);
        if let Some(index) = result.iter().position(|b| *b == b'\n') {
            if index + 1 != result.len() {
                return Err(io::Error::other("one request per connection"));
            }
            result.pop();
            return Ok(result);
        }
    }
}
pub(super) fn write_line(handle: HANDLE, bytes: &[u8], stopped: &AtomicBool) -> io::Result<()> {
    if bytes.len() + 1 > super::super::protocol::MAX_BYTES {
        return Err(io::Error::other("pipe response bound"));
    }
    let mut frame = bytes.to_vec();
    frame.push(b'\n');
    let began = Instant::now();
    let mut offset = 0;
    while offset < frame.len() {
        let remaining = Duration::from_secs(5)
            .checked_sub(began.elapsed())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "pipe write deadline"))?;
        let chunk = frame
            .get(offset..)
            .ok_or_else(|| io::Error::other("write offset"))?;
        let count = operation(handle, remaining, stopped, |overlapped| {
            // SAFETY: immutable frame remains alive through operation completion/cancellation.
            pending(unsafe {
                WriteFile(
                    handle,
                    chunk.as_ptr(),
                    chunk.len() as u32,
                    ptr::null_mut(),
                    overlapped,
                )
            })
        })? as usize;
        if count == 0 || count > chunk.len() {
            return Err(io::Error::other("write progress rejected"));
        }
        offset += count;
    }
    Ok(())
}
