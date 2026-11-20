use super::*;
use crate::pty::{PtyEvent, PtyHandle, read_events};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn receipt() -> Receipt {
    let _gate = crate::spawn_gate::lock().unwrap();
    Receipt::new().unwrap()
}

#[test]
fn receipt_eof_is_not_exec_confirmation() {
    let receipt = receipt();
    drop(receipt.writer);
    assert_eq!(
        receive(receipt.reader, TIMEOUT).unwrap(),
        LaunchOutcome::Unconfirmed(LaunchUnknown::ChannelClosed)
    );
}

#[test]
fn receipt_deadline_partial_malformed_and_io_error_are_unknown() {
    let receipt = receipt();
    let started = Instant::now();
    assert!(matches!(
        receive(receipt.reader, Duration::from_millis(20)),
        Err(PtyError::LaunchUnknown(LaunchUnknown::Timeout))
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(receipt.writer);

    for (bytes, reason) in [
        (&b"BL"[..], LaunchUnknown::PartialReceipt),
        (&b"garbage!"[..], LaunchUnknown::MalformedReceipt),
        (
            &b"BL\x01\x09\x02\0\0\0"[..],
            LaunchUnknown::MalformedReceipt,
        ),
        (&b"BL\x01\x02\0\0\0\0"[..], LaunchUnknown::MalformedReceipt),
    ] {
        let mut receipt = self::receipt();
        receipt.writer.write_all(bytes).unwrap();
        drop(receipt.writer);
        assert!(
            matches!(receive(receipt.reader, TIMEOUT), Err(PtyError::LaunchUnknown(actual)) if actual == reason)
        );
    }
    let file = std::fs::File::open("/").unwrap();
    assert!(matches!(
        receive(file, TIMEOUT),
        Err(PtyError::LaunchUnknown(LaunchUnknown::ChannelError))
    ));
}

#[test]
fn receipt_partial_without_eof_still_has_a_deadline() {
    let mut receipt = receipt();
    receipt.writer.write_all(b"BL").unwrap();
    assert!(matches!(
        receive(receipt.reader, Duration::from_millis(20)),
        Err(PtyError::LaunchUnknown(LaunchUnknown::Timeout))
    ));
    drop(receipt.writer);
}

#[test]
fn real_child_killed_before_exec_only_produces_unconfirmed_eof() {
    let gate = crate::spawn_gate::lock().unwrap();
    let receipt = Receipt::new().unwrap();
    let reader_fd = receipt.reader.as_raw_fd();
    // SAFETY: child uses only close/getpid/kill/_exit; never Rust destructors.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        // SAFETY: inherited pipe end; SIGKILL targets only this test child.
        unsafe {
            libc::close(reader_fd);
            libc::kill(libc::getpid(), libc::SIGKILL);
            libc::_exit(99);
        }
    }
    drop(receipt.writer);
    drop(gate);
    assert_eq!(
        receive(receipt.reader, TIMEOUT).unwrap(),
        LaunchOutcome::Unconfirmed(LaunchUnknown::ChannelClosed)
    );
    let mut status = 0;
    // SAFETY: this test exclusively owns the direct child and its wait status.
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    assert!(libc::WIFSIGNALED(status));
    assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
}

fn spawn(executable: &str, args: &[String]) -> Result<crate::pty::PtyJob, PtyError> {
    PtyHandle::spawn(
        format!("launch-test-{executable}"),
        Path::new("/"),
        executable,
        args,
        80,
        24,
        &[],
    )
}

#[test]
fn missing_binary_and_missing_script_interpreter_are_definitive_exec_failures() {
    assert!(matches!(
        spawn("/bigbud-no-such-executable", &[]),
        Err(PtyError::LaunchFailed {
            stage: LaunchStage::Exec,
            errno: libc::ENOENT
        })
    ));
    let root = std::env::temp_dir().join(format!(
        "bigbud-launch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let script = root.join("missing-interpreter");
    std::fs::write(&script, "#!/bigbud-no-such-interpreter\nexit 0\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(
        spawn(script.to_str().unwrap(), &[]),
        Err(PtyError::LaunchFailed {
            stage: LaunchStage::Exec,
            errno: libc::ENOENT
        })
    ));
    std::fs::remove_dir_all(root).unwrap();
    // Failed setup must retain a reap owner, not return a live job or fallback.
    let retained = super::super::cleanup::retained_children();
    assert!(!retained.is_empty());
    let deadline = Instant::now() + Duration::from_secs(2);
    while retained.iter().any(|child| !child.reaped()) && Instant::now() < deadline {
        super::super::cleanup::poll();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(retained.iter().all(|child| child.reaped()));
}

#[test]
fn valid_explicit_executable_preserves_argv_and_cwd_but_is_not_attested() {
    let job = spawn(
        "/bin/sh",
        &[
            "-c".into(),
            "printf '%s:%s:%s' \"$0\" \"$1\" \"$PWD\"".into(),
            "argv-zero".into(),
            "literal ; $value".into(),
        ],
    )
    .unwrap();
    assert_eq!(
        job.handle.launch_outcome(),
        LaunchOutcome::Unconfirmed(LaunchUnknown::ChannelClosed)
    );
    let events = read_events(job.reader, &job.handle);
    let output: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            PtyEvent::Output(bytes) => Some(bytes.as_slice()),
            _ => None,
        })
        .flatten()
        .copied()
        .collect();
    assert_eq!(output, b"argv-zero:literal ; $value:/");
    assert!(events.iter().any(|event| matches!(
        event,
        PtyEvent::Exited {
            exit_code: Some(0),
            ..
        }
    )));
    job.handle.close(false).unwrap();
}
