use std::{
    fs::File,
    io,
    os::windows::io::AsRawHandle,
    sync::mpsc::{Receiver, SyncSender, sync_channel},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use bigbud_ssh_owner::framing::{Endpoint, FrameError};
use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{IO::CancelSynchronousIo, Threading::WaitForSingleObject},
};

use crate::RunResult;

use super::{FRAME_TIMEOUT, time_left};

const STOP_TIMEOUT: Duration = Duration::from_millis(250);

// Backend stdout can be a synchronous pipe, even if the backend's own read
// handle is asynchronous. A stalled backend must never strand the dispatcher
// in WriteFile with a live owner. The worker owns only stdout and at most one
// outstanding reply. Neither subprocess ownership nor authority crosses here.
pub(super) struct Writer {
    pending: SyncSender<Vec<u8>>,
    completed: Receiver<Result<(), FrameError>>,
    worker: JoinHandle<()>,
}

impl Writer {
    pub(super) fn start(mut output: File) -> io::Result<Self> {
        let (pending, replies) = sync_channel::<Vec<u8>>(1);
        let (done, completed) = sync_channel(1);
        let worker = thread::Builder::new()
            .name("picker-replies".into())
            .spawn(move || {
                while let Ok(reply) = replies.recv() {
                    let result = Endpoint::Owner.write_frame(&mut output, &reply);
                    let failed = result.is_err();
                    if done.send(result).is_err() || failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            pending,
            completed,
            worker,
        })
    }

    pub(super) fn send(&mut self, reply: Vec<u8>) -> RunResult<()> {
        use std::sync::mpsc::RecvTimeoutError;

        self.pending.try_send(reply).map_err(|_| writer_stopped())?;
        match self.completed.recv_timeout(FRAME_TIMEOUT) {
            Ok(result) => Ok(result?),
            Err(RecvTimeoutError::Disconnected) => Err(writer_stopped().into()),
            Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "picker backend stopped reading replies",
            )
            .into()),
        }
    }

    pub(super) fn stop(self) -> RunResult<()> {
        drop((self.pending, self.completed));
        let deadline = Instant::now() + STOP_TIMEOUT;
        // Cancellation can race the worker entering WriteFile. Retry only
        // during shutdown; a partial output frame is never sent again. On
        // timeout the one-shot dispatcher exits after its owner was reaped.
        loop {
            time_left(deadline)?;
            // SAFETY: a live JoinHandle owns the worker thread handle. The
            // worker only uses synchronous I/O on its own output handle.
            if unsafe { CancelSynchronousIo(self.worker.as_raw_handle()) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) {
                    return Err(error.into());
                }
            }
            // SAFETY: the same retained thread handle is live for the wait.
            match unsafe { WaitForSingleObject(self.worker.as_raw_handle(), 5) } {
                WAIT_OBJECT_0 => return self.worker.join().map_err(|_| writer_stopped().into()),
                WAIT_TIMEOUT => continue,
                _ => return Err(io::Error::last_os_error().into()),
            }
        }
    }
}

fn writer_stopped() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "picker reply writer stopped")
}
