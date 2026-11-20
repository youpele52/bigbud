//! Runs one `locate` process with a deadline and a cancel flag. The child is started directly
//! (no shell) with stdin closed; stdout is streamed to the caller in chunks and stderr is only
//! drained and reduced to "something was written" (its text is never kept or logged). Every exit
//! path kills the child if it is still running, reaps it and joins both reader threads.

use std::ffi::OsStr;
use std::io::{ErrorKind, Read};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::time::Instant;

use super::stop::{POLL_INTERVAL, check_stop, next_wait};
use crate::search::StopReason;

/// Bytes per stdout read.
const CHUNK_BYTES: usize = 64 * 1024;
/// Chunks buffered between the reader thread and the caller (bounded backpressure).
const CHANNEL_CHUNKS: usize = 4;

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    /// The process exited on its own after closing stdout.
    Exited {
        code: Option<i32>,
        stderr_written: bool,
    },
    /// The run was stopped (and the child killed): cancel, deadline, or the consumer had enough
    /// ([`StopReason::Limit`]).
    Stopped(StopReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnError {
    /// The program is not installed (not found on `PATH`).
    Missing,
    /// It exists but could not be started or supervised.
    Failed,
}

/// Runs `program args…`, passing each stdout chunk to `on_chunk` until it returns `false`, the
/// output ends, `cancel` is set or `deadline_at` passes.
pub fn run_streaming(
    program: &OsStr,
    args: &[String],
    cancel: &AtomicBool,
    deadline_at: Instant,
    mut on_chunk: impl FnMut(&[u8]) -> bool,
) -> Result<RunEnd, SpawnError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            ErrorKind::NotFound => SpawnError::Missing,
            _ => SpawnError::Failed,
        })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        // Unreachable with piped stdio; stop the child rather than leave it running.
        let _settled = stop_child(&mut child);
        return Err(SpawnError::Failed);
    };
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CHUNKS);
        let stdout_reader = scope.spawn(move || pump_stdout(stdout, &sender));
        let stderr_reader = scope.spawn(move || drain_stderr(stderr));
        let mut stopped = None;
        loop {
            if let Some(reason) = check_stop(cancel, deadline_at) {
                stopped = Some(reason);
                break;
            }
            match receiver.recv_timeout(next_wait(deadline_at)) {
                Ok(chunk) if on_chunk(&chunk) => {}
                Ok(_) => {
                    stopped = Some(StopReason::Limit);
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // Unblocks a reader waiting on a full channel; it then sees the closed pipe or EOF.
        drop(receiver);
        let end = match stopped {
            Some(reason) => stop_child(&mut child).map(|()| RunEnd::Stopped(reason)),
            None => wait_after_eof(&mut child, cancel, deadline_at),
        };
        let stdout_joined = stdout_reader.join().is_ok();
        let stderr_written = stderr_reader.join();
        match (end, stdout_joined, stderr_written) {
            (Ok(RunEnd::Exited { code, .. }), true, Ok(stderr_written)) => Ok(RunEnd::Exited {
                code,
                stderr_written,
            }),
            (Ok(stopped @ RunEnd::Stopped(_)), true, Ok(_)) => Ok(stopped),
            // A reader panicked or the child could not be reaped: the output cannot be trusted.
            _ => Err(SpawnError::Failed),
        }
    })
}

/// stdout closed; the child normally exits at once, but it is still bounded by cancel and the
/// deadline.
fn wait_after_eof(
    child: &mut Child,
    cancel: &AtomicBool,
    deadline_at: Instant,
) -> Result<RunEnd, SpawnError> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(RunEnd::Exited {
                    code: status.code(),
                    // Filled in by the caller once the stderr reader has finished.
                    stderr_written: false,
                });
            }
            Ok(None) => {}
            Err(_) => {
                stop_child(child)?;
                return Err(SpawnError::Failed);
            }
        }
        if let Some(reason) = check_stop(cancel, deadline_at) {
            return stop_child(child).map(|()| RunEnd::Stopped(reason));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Kills the child if it is still running and reaps it.
fn stop_child(child: &mut Child) -> Result<(), SpawnError> {
    match child.kill() {
        // `InvalidInput` means it had already exited; it still has to be reaped.
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::InvalidInput => {}
        Err(_) => return Err(SpawnError::Failed),
    }
    child
        .wait()
        .map(|_status| ())
        .map_err(|_| SpawnError::Failed)
}

fn pump_stdout(mut stdout: ChildStdout, sender: &SyncSender<Vec<u8>>) {
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                let Some(data) = buffer.get(..read) else {
                    return;
                };
                if sender.send(data.to_vec()).is_err() {
                    // The caller stopped listening; it kills the child next.
                    return;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// Reads stderr to the end so the child can never block on it, and reports whether anything
/// other than whitespace was written.
fn drain_stderr(mut stderr: ChildStderr) -> bool {
    let mut buffer = [0_u8; 1024];
    let mut written = false;
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => return written,
            Ok(read) => {
                written |= buffer
                    .iter()
                    .take(read)
                    .any(|byte| !byte.is_ascii_whitespace());
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            // A broken stderr pipe counts as "written", so the run is not mistaken for success.
            Err(_) => return true,
        }
    }
}
