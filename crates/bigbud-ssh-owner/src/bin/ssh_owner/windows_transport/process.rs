use std::{
    fs::File,
    io::{self, Read},
    os::windows::io::{AsRawHandle, FromRawHandle},
    process::{Child, Command, ExitStatus, Stdio},
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_BROKEN_PIPE, HANDLE, WAIT_OBJECT_0},
    System::{
        Pipes::{CreatePipe, PeekNamedPipe},
        Threading::WaitForSingleObject,
    },
};

const POLL: Duration = Duration::from_millis(5);
const REAP_MS: u32 = 250;

#[derive(Debug)]
pub(super) enum Failure {
    TimedOut,
    Spawn,
    Io,
}

pub(super) struct Output {
    pub status: ExitStatus,
    pub stdout: Capture,
    pub stderr: Capture,
}

pub(super) struct Capture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    limit: usize,
}

impl Capture {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
            limit,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let keep = self.limit.saturating_sub(self.bytes.len()).min(bytes.len());
        if let Some(prefix) = bytes.get(..keep) {
            self.bytes.extend_from_slice(prefix);
        }
        self.truncated |= keep < bytes.len();
    }
}

pub(super) fn run(
    mut command: Command,
    deadline: Instant,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<Output, Failure> {
    let (mut out, stdout) = pipe().map_err(|_| Failure::Io)?;
    let (mut err, stderr) = pipe().map_err(|_| Failure::Io)?;
    if Instant::now() >= deadline {
        return Err(Failure::TimedOut);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let child = command.spawn();
    // Drop the parent's write ends (held by Command), even on spawn failure.
    drop(command);
    let mut child = child.map_err(|_| Failure::Spawn)?;
    let result = collect(
        &mut child,
        &mut out,
        &mut err,
        deadline,
        stdout_limit,
        stderr_limit,
    );
    if result.is_err() {
        reap_on_error(&mut child)?;
    }
    result
}

fn collect(
    child: &mut Child,
    out: &mut File,
    err: &mut File,
    deadline: Instant,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<Output, Failure> {
    let mut stdout = Capture::new(stdout_limit);
    let mut stderr = Capture::new(stderr_limit);
    loop {
        if Instant::now() >= deadline {
            return Err(Failure::TimedOut);
        }
        let out_state = sample(out, &mut stdout).map_err(|_| Failure::Io)?;
        let err_state = sample(err, &mut stderr).map_err(|_| Failure::Io)?;
        if out_state == PipeState::Closed
            && err_state == PipeState::Closed
            && let Some(status) = child.try_wait().map_err(|_| Failure::Io)?
        {
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        if out_state != PipeState::Drained && err_state != PipeState::Drained {
            thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }
}

fn reap_on_error(child: &mut Child) -> Result<(), Failure> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    // If the process raced our termination request and exited itself, waiting
    // still succeeds. On Windows reaping means observing the signaled handle;
    // dropping Child then releases it. Never perform an unbounded wait.
    let kill = child.kill();
    // SAFETY: Child owns this live process handle throughout the bounded wait.
    let reaped = unsafe { WaitForSingleObject(child.as_raw_handle(), REAP_MS) } == WAIT_OBJECT_0;
    match (kill, reaped) {
        (_, true) => Ok(()),
        (_, false) => Err(Failure::Io),
    }
}

fn pipe() -> io::Result<(File, File)> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    // SAFETY: valid output slots. Null attributes make both handles non-inheritable.
    // Stdio arranges inheritance of only the child-side write handle.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreatePipe transferred two fresh distinct handles.
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

#[derive(PartialEq, Eq)]
enum PipeState {
    Closed,
    Drained,
    Idle,
}

fn sample(pipe: &mut File, capture: &mut Capture) -> io::Result<PipeState> {
    let mut ready = 0;
    // SAFETY: the live handle is the byte read end from CreatePipe; PeekNamedPipe
    // supports anonymous pipes. Only ready is requested and writable.
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut ready,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
            Ok(PipeState::Closed)
        } else {
            Err(error)
        };
    }
    if ready == 0 {
        return Ok(PipeState::Idle);
    }
    let mut bytes = [0; 8192];
    let len = (ready as usize).min(bytes.len());
    // No other reader owns this handle. Read no more than Peek found queued.
    let buffer = bytes
        .get_mut(..len)
        .ok_or_else(|| io::Error::other("invalid pipe read bound"))?;
    let read = pipe.read(buffer)?;
    let bytes = buffer
        .get(..read)
        .ok_or_else(|| io::Error::other("invalid pipe read length"))?;
    capture.push(bytes);
    Ok(if read == 0 {
        PipeState::Closed
    } else {
        PipeState::Drained
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_output_is_bounded_across_chunks() {
        let mut capture = Capture::new(4);
        capture.push(b"ab");
        capture.push(b"cd");
        assert!(!capture.truncated);
        capture.push(b"efghijkl");
        assert!(capture.truncated);
        assert_eq!(capture.bytes, b"abcd");
    }

    #[test]
    fn only_reads_available_bytes_and_detects_closed_writer() {
        use std::io::Write;
        let (mut reader, mut writer) = pipe().expect("pipe");
        let mut capture = Capture::new(3);
        assert!(sample(&mut reader, &mut capture).expect("idle read") == PipeState::Idle);
        writer.write_all(b"hello").expect("write fixture bytes");
        drop(writer);
        assert!(sample(&mut reader, &mut capture).expect("drain read") == PipeState::Drained);
        assert!(sample(&mut reader, &mut capture).expect("closed read") == PipeState::Closed);
        assert_eq!(capture.bytes, b"hel");
        assert!(capture.truncated);
    }
}
