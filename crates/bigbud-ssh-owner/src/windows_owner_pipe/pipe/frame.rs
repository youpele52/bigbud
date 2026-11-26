use super::{
    VerifiedPipe,
    overlapped::{Deadline, Operation},
};
use crate::framing::{Endpoint, FrameError};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr, thread,
    time::Duration,
};
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

#[derive(Debug, PartialEq, Eq)]
pub enum PipeReadiness {
    Ready,
    Idle,
    Closed,
}

impl VerifiedPipe {
    /// Waits without consuming bytes. A quiet timeout preserves the endpoint; the
    /// subsequent frame read still retires it on partial-frame timeout or I/O loss.
    pub fn wait_for_input(&mut self, timeout: Duration) -> Result<PipeReadiness, FrameError> {
        let deadline = Deadline::new(timeout).map_err(FrameError::ReadHeader)?;
        self.with_pipe(
            |handle, _| loop {
                let mut available = 0;
                // SAFETY: The connected handle is held exclusively by this call. No
                // bytes or pointers are returned; only the available count is written.
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
                    let error = io::Error::last_os_error();
                    return if disconnect(&error) {
                        Ok((PipeReadiness::Closed, false))
                    } else {
                        Err(FrameError::ReadHeader(error))
                    };
                }
                if available > 0 {
                    return Ok((PipeReadiness::Ready, true));
                }
                match deadline.remaining() {
                    Ok(left) => thread::sleep(left.min(Duration::from_millis(25))),
                    Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                        return Ok((PipeReadiness::Idle, true));
                    }
                    Err(error) => return Err(FrameError::ReadHeader(error)),
                }
            },
            FrameError::ReadHeader,
        )
    }

    /// Reads one v1 length-prefixed payload using the local endpoint's inbound
    /// limit. The timeout (at most two seconds) covers the header and body
    /// together. EOF before any header byte returns `None`. EOF or any error
    /// closes the endpoint permanently. Payload validation and any application
    /// authentication still belong to the caller, who must drop the pipe on failure.
    pub fn read_frame(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>, FrameError> {
        self.with_pipe(
            |handle, role| {
                let deadline = Deadline::new(timeout).map_err(FrameError::ReadHeader)?;
                let operation =
                    Operation::new(handle, &deadline).map_err(FrameError::ReadHeader)?;
                let frame = role.read_frame(&mut FramedIo(operation))?;
                let keep_open = frame.is_some();
                deadline.remaining().map_err(if keep_open {
                    FrameError::ReadPayload
                } else {
                    FrameError::ReadHeader
                })?;
                Ok((frame, keep_open))
            },
            FrameError::ReadHeader,
        )
    }

    /// Writes one opaque v1 payload using the local endpoint's outbound limit.
    /// The timeout (at most two seconds) covers the whole frame. An error closes
    /// the endpoint, even if no bytes were sent. Never retry a partial write.
    pub fn write_frame(&mut self, payload: &[u8], timeout: Duration) -> Result<(), FrameError> {
        self.with_pipe(
            |handle, role| {
                let deadline = Deadline::new(timeout).map_err(FrameError::Write)?;
                let operation = Operation::new(handle, &deadline).map_err(FrameError::Write)?;
                role.write_frame(&mut FramedIo(operation), payload)?;
                deadline.remaining().map_err(FrameError::Write)?;
                Ok(((), true))
            },
            FrameError::Write,
        )
    }

    fn with_pipe<T>(
        &mut self,
        use_pipe: impl FnOnce(&OwnedHandle, Endpoint) -> Result<(T, bool), FrameError>,
        closed: impl FnOnce(io::Error) -> FrameError,
    ) -> Result<T, FrameError> {
        // Keep ownership in this call until successful completion. No raw or
        // detached handle escapes, including on EOF, error, or unwind.
        let handle = self.handle.take().ok_or_else(|| {
            closed(io::Error::new(
                io::ErrorKind::NotConnected,
                "verified owner pipe is closed",
            ))
        })?;
        let (value, keep_open) = use_pipe(&handle, self.endpoint)?;
        if keep_open {
            self.handle = Some(handle);
        }
        Ok(value)
    }
}

fn disconnect(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error().map(|code| code as u32),
        Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
    )
}

// Private adapter for the shared framing codec. All calls share one deadline;
// none of the raw byte operations or generic traits escape VerifiedPipe.
pub(super) struct FramedIo<'a>(pub(super) Operation<'a>);

impl io::Read for FramedIo<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        match self.0.read(bytes) {
            Err(err) if disconnect(&err) => Ok(0),
            // A live pipe can return a zero-byte write; that's not clean EOF.
            Ok(0) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zero-byte owner pipe read",
            )),
            result => result,
        }
    }
}

impl io::Write for FramedIo<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.0.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        // No userspace buffering; FlushFileBuffers on a pipe can wait for the peer.
        Ok(())
    }
}
