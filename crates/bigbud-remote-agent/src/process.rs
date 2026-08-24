use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::operations::OutputStream;

const READ_CHUNK_BYTES: usize = 16 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const BASELINE_ENVIRONMENT_NAMES: [&str; 10] = [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
];
const PROTECTED_ENVIRONMENT_NAMES: [&str; 4] = ["HOME", "PATH", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub output_truncated: bool,
}

pub struct ProcessOptions<'a> {
    pub environment: &'a [(String, String)],
    pub stdin_bytes: &'a [u8],
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub cancellation: Option<&'a AtomicBool>,
}

pub type ProcessOutputCallback = std::sync::Arc<dyn Fn(OutputStream, &[u8]) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("process command is empty")]
    EmptyCommand,
    #[error("failed to spawn process: {0}")]
    Spawn(#[source] io::Error),
    #[error("failed to terminate process: {0}")]
    Kill(#[source] io::Error),
    #[error("failed to read process output: {0}")]
    Read(#[source] io::Error),
    #[error("failed to join process output reader")]
    ReaderJoin,
}

pub fn run_bounded_process(
    workspace_root: &Path,
    command: &str,
    args: &[String],
    options: ProcessOptions<'_>,
) -> Result<ProcessResult, ProcessError> {
    run_bounded_process_internal(workspace_root, command, args, options, None)
}

pub fn run_bounded_process_with_output(
    workspace_root: &Path,
    command: &str,
    args: &[String],
    options: ProcessOptions<'_>,
    output_callback: ProcessOutputCallback,
) -> Result<ProcessResult, ProcessError> {
    run_bounded_process_internal(
        workspace_root,
        command,
        args,
        options,
        Some(output_callback),
    )
}

fn run_bounded_process_internal(
    workspace_root: &Path,
    command: &str,
    args: &[String],
    options: ProcessOptions<'_>,
    output_callback: Option<ProcessOutputCallback>,
) -> Result<ProcessResult, ProcessError> {
    if command.is_empty() {
        return Err(ProcessError::EmptyCommand);
    }
    let mut process = Command::new(command);
    process
        .env_clear()
        .args(args)
        .current_dir(workspace_root)
        .stdin(if options.stdin_bytes.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in BASELINE_ENVIRONMENT_NAMES {
        if let Some(value) = std::env::var_os(name) {
            process.env(name, value);
        }
    }
    for (name, value) in options.environment {
        if !PROTECTED_ENVIRONMENT_NAMES.contains(&name.as_str()) {
            process.env(name, value);
        }
    }
    configure_process_group(&mut process);
    let mut child = process.spawn().map_err(ProcessError::Spawn)?;
    let stdin_writer = if options.stdin_bytes.is_empty() {
        None
    } else {
        let mut stdin = child.stdin.take().ok_or(ProcessError::ReaderJoin)?;
        let bytes = options.stdin_bytes.to_vec();
        Some(thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        }))
    };
    let stdout = child.stdout.take().ok_or(ProcessError::ReaderJoin)?;
    let stderr = child.stderr.take().ok_or(ProcessError::ReaderJoin)?;
    let stdout_callback = output_callback.clone();
    let stderr_callback = output_callback;
    let stdout_reader = thread::spawn(move || {
        read_bounded(
            stdout,
            options.max_output_bytes,
            OutputStream::Stdout,
            stdout_callback,
        )
    });
    let stderr_reader = thread::spawn(move || {
        read_bounded(
            stderr,
            options.max_output_bytes,
            OutputStream::Stderr,
            stderr_callback,
        )
    });
    let deadline = Instant::now() + options.timeout;
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(ProcessError::Read)? {
            break status;
        }
        if options
            .cancellation
            .is_some_and(|signal| signal.load(Ordering::Relaxed))
        {
            terminate_process_tree(&mut child).map_err(ProcessError::Kill)?;
            break child.wait().map_err(ProcessError::Read)?;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            terminate_process_tree(&mut child).map_err(ProcessError::Kill)?;
            break child.wait().map_err(ProcessError::Read)?;
        }
        thread::sleep(POLL_INTERVAL);
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| ProcessError::ReaderJoin)??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ProcessError::ReaderJoin)??;
    if let Some(stdin_writer) = stdin_writer {
        stdin_writer.join().map_err(|_| ProcessError::ReaderJoin)?;
    }
    Ok(ProcessResult {
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        exit_code: status.code(),
        timed_out,
        cancelled: options
            .cancellation
            .is_some_and(|signal| signal.load(Ordering::Relaxed))
            && !timed_out,
        output_truncated: stdout.truncated || stderr.truncated,
    })
}

#[cfg(unix)]
fn configure_process_group(process: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        process.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_process: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) -> io::Result<()> {
    let process_group = -(child.id() as i32);
    let result = unsafe { libc::kill(process_group, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_process_tree(child: &mut Child) -> io::Result<()> {
    child.kill()
}

struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_bounded(
    mut reader: impl Read,
    max_output_bytes: usize,
    stream: OutputStream,
    output_callback: Option<ProcessOutputCallback>,
) -> Result<BoundedOutput, ProcessError> {
    let mut bytes = Vec::with_capacity(max_output_bytes.min(READ_CHUNK_BYTES));
    let mut chunk = [0; READ_CHUNK_BYTES];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).map_err(ProcessError::Read)?;
        if read == 0 {
            break;
        }
        let remaining = max_output_bytes.saturating_sub(bytes.len());
        let retained = read.min(remaining);
        if retained > 0 {
            bytes.extend_from_slice(&chunk[..retained]);
            if let Some(output_callback) = &output_callback {
                output_callback(stream, &chunk[..retained]);
            }
        }
        if read > remaining {
            truncated = true;
        }
    }
    Ok(BoundedOutput { bytes, truncated })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const TEST_PROCESS_TIMEOUT: Duration = Duration::from_secs(10);
    static PROCESS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_process_test() -> std::sync::MutexGuard<'static, ()> {
        PROCESS_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(unix)]
    #[test]
    fn captures_separate_bounded_output() {
        let _guard = lock_process_test();
        let result = run_bounded_process(
            Path::new("."),
            "sh",
            &[
                "-c".to_owned(),
                "printf stdout; printf stderr >&2".to_owned(),
            ],
            ProcessOptions {
                environment: &[],
                stdin_bytes: &[],
                timeout: TEST_PROCESS_TIMEOUT,
                max_output_bytes: 4,
                cancellation: None,
            },
        )
        .unwrap();
        assert_eq!(result.stdout, b"stdo");
        assert_eq!(result.stderr, b"stde");
        assert!(result.output_truncated);
        assert_eq!(result.exit_code, Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn terminates_a_timed_out_process() {
        let _guard = lock_process_test();
        let result = run_bounded_process(
            Path::new("."),
            "sh",
            &["-c".to_owned(), "sleep 1".to_owned()],
            ProcessOptions {
                environment: &[],
                stdin_bytes: &[],
                timeout: Duration::from_millis(20),
                max_output_bytes: 64,
                cancellation: None,
            },
        )
        .unwrap();
        assert!(result.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn supplies_explicit_stdin_and_environment() {
        let _guard = lock_process_test();
        let result = run_bounded_process(
            Path::new("."),
            "sh",
            &[
                "-c".to_owned(),
                "read value; printf '%s-%s' \"$value\" \"$BIGBUD_TEST\"".to_owned(),
            ],
            ProcessOptions {
                environment: &[("BIGBUD_TEST".to_owned(), "value".to_owned())],
                stdin_bytes: b"input\n",
                timeout: TEST_PROCESS_TIMEOUT,
                max_output_bytes: 64,
                cancellation: None,
            },
        )
        .unwrap();
        assert_eq!(result.stdout, b"input-value");
        assert_eq!(result.exit_code, Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn preserves_remote_user_environment_and_ignores_protected_overrides() {
        let _guard = lock_process_test();
        let expected_home = std::env::var("HOME").unwrap();
        let expected_path = std::env::var("PATH").unwrap();
        let result = run_bounded_process(
            Path::new("."),
            "sh",
            &[
                "-c".to_owned(),
                "printf '%s\n%s' \"$HOME\" \"$PATH\"".to_owned(),
            ],
            ProcessOptions {
                environment: &[
                    ("HOME".to_owned(), "/untrusted/home".to_owned()),
                    ("PATH".to_owned(), "/untrusted/path".to_owned()),
                ],
                stdin_bytes: &[],
                timeout: TEST_PROCESS_TIMEOUT,
                max_output_bytes: 16 * 1024,
                cancellation: None,
            },
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            format!("{expected_home}\n{expected_path}")
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminates_when_cancellation_is_requested() {
        let _guard = lock_process_test();
        let cancellation = AtomicBool::new(false);
        let signal = &cancellation;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(20));
                signal.store(true, Ordering::Relaxed);
            });
            let result = run_bounded_process(
                Path::new("."),
                "sh",
                &["-c".to_owned(), "sleep 1".to_owned()],
                ProcessOptions {
                    environment: &[],
                    stdin_bytes: &[],
                    timeout: TEST_PROCESS_TIMEOUT,
                    max_output_bytes: 64,
                    cancellation: Some(signal),
                },
            )
            .unwrap();
            assert!(result.cancelled);
        });
    }

    #[cfg(unix)]
    #[test]
    fn streams_bounded_output_before_process_completion() {
        let _guard = lock_process_test();
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = std::sync::Arc::clone(&chunks);
        let result = run_bounded_process_with_output(
            Path::new("."),
            "sh",
            &[
                "-c".to_owned(),
                "printf first; sleep 0.02; printf second".to_owned(),
            ],
            ProcessOptions {
                environment: &[],
                stdin_bytes: &[],
                timeout: TEST_PROCESS_TIMEOUT,
                max_output_bytes: 64,
                cancellation: None,
            },
            std::sync::Arc::new(move |stream, bytes| {
                received.lock().unwrap().push((stream, bytes.to_vec()));
            }),
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        let chunks = chunks.lock().unwrap();
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].0, OutputStream::Stdout);
        assert_eq!(
            chunks.iter().map(|(_, bytes)| bytes.len()).sum::<usize>(),
            11
        );
    }
}
