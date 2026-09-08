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
