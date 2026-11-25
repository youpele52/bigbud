use super::super::{
    policy::{remaining, validate_timeout},
    process::owned,
};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, WAIT_FAILED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    Storage::FileSystem::{ReadFile, WriteFile},
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::ConnectNamedPipe,
        Threading::{CreateEventW, ResetEvent, WaitForSingleObject},
    },
};

pub(super) struct Deadline {
    start: Instant,
    timeout: Duration,
}

impl Deadline {
    pub(super) fn new(timeout: Duration) -> io::Result<Self> {
        Self::starting_at(Instant::now(), timeout)
    }

    pub(super) fn until(end: Instant) -> io::Result<Self> {
        let start = Instant::now();
        Self::starting_at(start, end.saturating_duration_since(start))
    }

    fn starting_at(start: Instant, timeout: Duration) -> io::Result<Self> {
        validate_timeout(timeout)?;
        Ok(Self { start, timeout })
    }

    pub(super) fn remaining(&self) -> io::Result<Duration> {
        remaining(self.timeout, self.start.elapsed())
    }
}

// One private manual-reset event per sequence of operations. Each submitted
// request finishes (or is cancelled and drained) before this event is reused.
pub(super) struct Operation<'a> {
    pipe: &'a OwnedHandle,
    event: OwnedHandle,
    deadline: &'a Deadline,
}

impl<'a> Operation<'a> {
    pub(super) fn new(pipe: &'a OwnedHandle, deadline: &'a Deadline) -> io::Result<Self> {
        // SAFETY: fresh, unnamed, non-inheritable manual-reset event.
        let event = unsafe { owned(CreateEventW(ptr::null(), 1, 0, ptr::null())) }?;
        Ok(Self {
            pipe,
            event,
            deadline,
        })
    }

    pub(super) fn accept(&mut self) -> io::Result<()> {
        let pipe = self.pipe.as_raw_handle();
        self.submit(Some(ERROR_PIPE_CONNECTED), |request| {
            // SAFETY: pipe was opened overlapped; submit keeps request live until completion.
            unsafe { ConnectNamedPipe(pipe, request) }
        })?;
        Ok(())
    }

    pub(super) fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let pipe = self.pipe.as_raw_handle();
        let len = transfer_len(bytes.len());
        let buffer = bytes.as_mut_ptr();
        self.submit(None, |request| {
            // SAFETY: the caller's exclusive buffer stays live and untouched until submit returns.
            unsafe { ReadFile(pipe, buffer, len, ptr::null_mut(), request) }
        })
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let pipe = self.pipe.as_raw_handle();
        let len = transfer_len(bytes.len());
        let buffer = bytes.as_ptr();
        self.submit(None, |request| {
            // SAFETY: the caller's immutable buffer stays live until submit returns.
            unsafe { WriteFile(pipe, buffer, len, ptr::null_mut(), request) }
        })
    }

    fn submit(
        &mut self,
        connected_race: Option<u32>,
        issue: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> io::Result<usize> {
        let pipe = self.pipe.as_raw_handle();
        let event = self.event.as_raw_handle();
        let mut overlapped = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        let request = &raw mut overlapped;
        // SAFETY: private, live event with no outstanding operation at this point.
        if unsafe { ResetEvent(event) } == 0 {
            return Err(io::Error::last_os_error());
        }
        self.deadline.remaining()?;
        if issue(request) == 0 {
            let err = io::Error::last_os_error();
            let code = err.raw_os_error().map(|code| code as u32);
            if connected_race.is_some() && connected_race == code {
                // A client arrived before ConnectNamedPipe; no I/O was queued.
                self.deadline.remaining()?;
                return Ok(0);
            }
            if code != Some(ERROR_IO_PENDING) {
                return Err(err);
            }
            if let Err(err) = self.wait() {
                self.cancel_and_drain(request);
                return Err(err);
            }
        }

        let mut transferred = 0;
        // SAFETY: request stayed at its original address. Either submission
        // completed inline or our private event signalled; do not wait here.
        if unsafe { GetOverlappedResult(pipe, request, &mut transferred, 0) } == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                self.cancel_and_drain(request);
            }
            return Err(err);
        }
        self.deadline.remaining()?;
        Ok(transferred as usize)
    }

    fn wait(&self) -> io::Result<()> {
        // Round up to avoid expiring early; the two-second cap fits in a DWORD.
        let millis = self.deadline.remaining()?.as_nanos().div_ceil(1_000_000) as u32;
        // SAFETY: the private event remains live for the bounded wait.
        match unsafe { WaitForSingleObject(self.event.as_raw_handle(), millis) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "owner pipe deadline expired",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected owner pipe wait status")),
        }
    }

    fn cancel_and_drain(&self, request: *const OVERLAPPED) {
        let pipe = self.pipe.as_raw_handle();
        // SAFETY: the specific submitted request and its buffer are still live.
        // Cancellation races completion and does not itself establish quiescence.
        let _ = unsafe { CancelIoEx(pipe, request) };
        let mut transferred = 0;
        // SAFETY: keep the overlapped, buffer, event and pipe alive through the
        // terminal result. This waits for local kernel cancellation/completion,
        // not peer I/O progress; Windows does not provide a hard cleanup deadline.
        // The result is deliberately discarded: even success after a timeout
        // does not permit the frame or endpoint to be reused.
        let _ = unsafe { GetOverlappedResult(pipe, request, &mut transferred, 1) };
    }
}

fn transfer_len(len: usize) -> u32 {
    // Keep each individual request bounded even for a maximum-size v1 frame.
    len.min(64 * 1024) as u32
}
