use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod cancellable;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use cancellable::run_with_combined_output_limit_cancellable;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
pub(super) use cancellable::{PickerFailure, run_picker_cancellable};
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod streamed;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use streamed::run_streamed_cancellable;

const STDERR_LIMIT: usize = 16 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const REAP_GRACE: Duration = Duration::from_millis(250);

pub(super) enum Failure {
    Spawn,
    TimedOut,
    Io,
}

pub(super) struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

#[derive(Clone, Copy)]
struct CaptureLimits {
    stdout: usize,
    stderr: usize,
    combined: Option<usize>,
}

impl CaptureLimits {
    fn separate(stdout: usize) -> Self {
        Self {
            stdout,
            stderr: STDERR_LIMIT,
            combined: None,
        }
    }

    fn combined(limit: usize) -> Self {
        Self {
            stdout: limit,
            stderr: limit,
            combined: Some(limit),
        }
    }

    fn available(self, captured: usize) -> usize {
        self.combined
            .map_or(usize::MAX, |limit| limit.saturating_sub(captured))
    }
}

pub(super) fn run(command: Command, deadline: Instant, limit: usize) -> Result<Output, Failure> {
    run_command(
        clean(command),
        deadline,
        CaptureLimits::separate(limit),
        None,
        || Ok(()),
        None,
    )
}

// Picker commands have already had their environment cleared and rebuilt
// by the bounded SendEnv policy (or clean below).
pub(super) fn run_picker(
    command: Command,
    deadline: Instant,
    limit: usize,
) -> Result<Output, Failure> {
    run_command(
        command,
        deadline,
        CaptureLimits::separate(limit),
        None,
        || Ok(()),
        None,
    )
}

pub(super) fn run_with_combined_output_limit(
    command: Command,
    deadline: Instant,
    limit: usize,
) -> Result<Output, Failure> {
    run_command(
        clean(command),
        deadline,
        CaptureLimits::combined(limit),
        None,
        || Ok(()),
        None,
    )
}

pub(super) fn run_with_input(
    command: Command,
    deadline: Instant,
    limit: usize,
    input: &[u8],
) -> Result<Output, Failure> {
    run_command(
        clean(command),
        deadline,
        CaptureLimits::separate(limit),
        Some(input),
        || Ok(()),
        None,
    )
}

pub(super) fn clean(mut command: Command) -> Command {
    command.env_clear().env("LC_ALL", "C");
    command
}

fn run_command<E: From<Failure>>(
    mut command: Command,
    deadline: Instant,
    limits: CaptureLimits,
    input: Option<&[u8]>,
    checkpoint: impl Fn() -> Result<(), E>,
    cleanup_error: Option<E>,
) -> Result<Output, E> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    checkpoint()?;
    if Instant::now() >= deadline {
        return Err(Failure::TimedOut.into());
    }
    let mut child = command.spawn().map_err(|_| Failure::Spawn)?;
    let result = collect(&mut child, deadline, limits, input, checkpoint);
    if result.is_err()
        && !teardown(&mut child)
        && let Some(error) = cleanup_error
    {
        return Err(error);
    }
    result
}

fn collect<E: From<Failure>>(
    child: &mut Child,
    deadline: Instant,
    limits: CaptureLimits,
    input: Option<&[u8]>,
    checkpoint: impl Fn() -> Result<(), E>,
) -> Result<Output, E> {
    let mut stdout = Capture::new(child.stdout.take().ok_or(Failure::Io)?, limits.stdout)?;
    let mut stderr = Capture::new(child.stderr.take().ok_or(Failure::Io)?, limits.stderr)?;
    let mut stdin = child.stdin.take();
    let mut pending: &[u8] = &[];
    if let Some(input) = input {
        set_nonblocking(stdin.as_ref().ok_or(Failure::Io)?)?;
        pending = input;
    }
    loop {
        // Each drain reads at most one chunk, so even permanently readable
        // output cannot starve the next cancellation/deadline checkpoint.
        checkpoint()?;
        if Instant::now() >= deadline {
            return Err(Failure::TimedOut.into());
        }
        let stdout_progress =
            stdout.drain(limits.available(stdout.bytes.len() + stderr.bytes.len()))?;
        let stderr_progress =
            stderr.drain(limits.available(stdout.bytes.len() + stderr.bytes.len()))?;
        let stdin_progress = feed(&mut stdin, &mut pending)?;
        // Keep the group leader unreaped until both output pipes close. If a local
        // descendant holds a pipe open, teardown can still signal the group.
        if stdout.eof && stderr.eof {
            checkpoint()?;
            if let Some(status) = child.try_wait().map_err(|_| Failure::Io)? {
                return Ok(Output {
                    status,
                    stdout: stdout.bytes,
                    stderr: stderr.bytes,
                    truncated: stdout.truncated || (limits.combined.is_some() && stderr.truncated),
                });
            }
        }
        if !stdout_progress && !stderr_progress && !stdin_progress {
            thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }
}

fn feed(stdin: &mut Option<ChildStdin>, pending: &mut &[u8]) -> Result<bool, Failure> {
    let Some(pipe) = stdin.as_mut() else {
        return Ok(false);
    };
    if !pending.is_empty() {
        match pipe.write(pending) {
            Ok(0) => return Err(Failure::Io),
            Ok(count) => *pending = pending.get(count..).ok_or(Failure::Io)?,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                // A command may reject the request without reading stdin. Keep
                // collecting its result rather than masking it with EPIPE.
                *stdin = None;
                return Ok(true);
            }
            Err(error) if would_block(&error) => return Ok(false),
            Err(_) => return Err(Failure::Io),
        }
    }
    if pending.is_empty() {
        *stdin = None; // Send EOF, including for an explicitly empty input.
    }
    Ok(true)
}

fn would_block(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn set_nonblocking(pipe: &impl AsFd) -> Result<(), Failure> {
    let fd = pipe.as_fd().as_raw_fd();
    // SAFETY: fd is a live, owned pipe endpoint and no other thread uses it.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } == -1 {
        return Err(Failure::Io);
    }
    Ok(())
}

struct Capture<Pipe> {
    pipe: Pipe,
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
    eof: bool,
}

impl<Pipe: AsFd + Read> Capture<Pipe> {
    fn new(pipe: Pipe, limit: usize) -> Result<Self, Failure> {
        set_nonblocking(&pipe)?;
        Ok(Self {
            pipe,
            bytes: Vec::new(),
            limit,
            truncated: false,
            eof: false,
        })
    }

    fn drain(&mut self, available: usize) -> Result<bool, Failure> {
        if self.eof {
            return Ok(false);
        }
        let mut buffer = [0; 8192];
        match self.pipe.read(&mut buffer) {
            Ok(0) => {
                self.eof = true;
                Ok(true)
            }
            Ok(count) => {
                let keep = count.min(self.limit - self.bytes.len()).min(available);
                self.truncated |= count > keep;
                self.bytes
                    .extend_from_slice(buffer.get(..keep).ok_or(Failure::Io)?);
                Ok(true)
            }
            Err(error) if would_block(&error) => Ok(false),
            Err(_) => Err(Failure::Io),
        }
    }
}

fn teardown(child: &mut Child) -> bool {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: spawn created this isolated group, its leader is unreaped,
        // and a strictly positive pid cannot name the caller's process group.
        if pid > 0 && unsafe { libc::kill(-pid, libc::SIGKILL) } == -1 {
            // If the group is inaccessible or gone, try the owned child itself.
            let _ = child.kill();
        }
    } else {
        let _ = child.kill();
    }
    let deadline = Instant::now() + REAP_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    false
}

pub(in super::super) fn ssh_failure(stderr: &[u8]) -> super::ErrorCode {
    use super::ErrorCode;
    let stderr = String::from_utf8_lossy(stderr);
    // A destination `MaxSessions` refusal is a quota condition, not an
    // authentication failure, even when the same message also mentions auth.
    if stderr.contains("open failed: administratively prohibited")
        || stderr.contains("MaxSessions")
        || stderr.contains("Too many sessions")
    {
        ErrorCode::SessionQuota
    } else if stderr.contains("Host key verification failed")
        || stderr.contains("no matching host key type found")
    {
        ErrorCode::HostKeyChanged
    } else if stderr.contains("Permission denied (") {
        ErrorCode::AuthRequired
    } else {
        ErrorCode::TransportLost
    }
}

#[cfg(test)]
mod cancellation_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::ErrorCode;

    #[test]
    fn max_sessions_maps_to_quota_never_auth() {
        for stderr in [
            b"open failed: administratively prohibited: open failed".as_slice(),
            b"Received disconnect from 127.0.0.1: Too many sessions".as_slice(),
            b"sshd: error: MaxSessions exceeded".as_slice(),
            b"Permission denied (publickey). open failed: administratively prohibited".as_slice(),
        ] {
            assert!(matches!(ssh_failure(stderr), ErrorCode::SessionQuota));
        }
        assert!(matches!(
            ssh_failure(b"Permission denied (publickey)."),
            ErrorCode::AuthRequired
        ));
    }

    #[test]
    fn bounds_capture_and_discards_excess() {
        let mut command = Command::new("/usr/bin/printf");
        command.arg("abcdefghijk");
        let output = run(command, Instant::now() + Duration::from_secs(1), 5)
            .map_err(|_| "printf failed")
            .expect("fixture print succeeds");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"abcde");
        assert!(output.truncated);
    }

    #[test]
    fn limits_total_retention_across_stdout_and_stderr() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 123456; printf abcdef >&2"]);
        let result =
            run_with_combined_output_limit(command, Instant::now() + Duration::from_secs(1), 8)
                .map_err(|_| "capture failed")
                .expect("fixture command completes");
        assert!(result.status.success());
        assert!(result.truncated);
        assert_eq!(result.stdout.len() + result.stderr.len(), 8);
    }

    #[test]
    fn times_out_and_terminates_without_waiting_for_child_sleep() {
        let mut command = Command::new("/bin/sleep");
        command.arg("8");
        let start = Instant::now();
        assert!(matches!(
            run(command, start + Duration::from_millis(100), 32),
            Err(Failure::TimedOut)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
