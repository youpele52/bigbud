use super::super::{NoConnection, accept_one};
use crate::owner_git_upload::listen;
use crate::transport::{StepRun, run_backend_step};
use crate::v1::ErrorCode;
use std::{
    io::Write,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

fn shell(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]).env_clear().env("LC_ALL", "C");
    command
}

fn run(script: &str, seconds: u64, limit: usize) -> StepRun {
    run_backend_step(
        &mut shell(script),
        Stdio::null(),
        Instant::now() + Duration::from_secs(seconds),
        limit,
        || false,
    )
}

#[test]
fn streamed_input_reaches_the_child_and_half_close_ends_it() {
    let Ok((socket, listener)) = listen() else {
        panic!("listen");
    };
    let path = socket.path().to_owned();
    let writer = thread::spawn(move || {
        let mut stream = UnixStream::connect(path).ok()?;
        stream.write_all(&[42; 70_000]).ok()?;
        stream.shutdown(std::net::Shutdown::Write).ok()
    });
    let Ok(stream) = accept_one(socket, listener, &|| false) else {
        panic!("accept");
    };
    let outcome = run_backend_step(
        &mut shell("wc -c | tr -d ' '"),
        Stdio::from(OwnedFd::from(stream)),
        Instant::now() + Duration::from_secs(10),
        64,
        || false,
    );
    assert!(writer.join().is_ok_and(|written| written.is_some()));
    match outcome {
        StepRun::Exited { code, stdout, .. } => {
            assert_eq!(code, 0);
            assert_eq!(stdout, b"70000\n");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_undialled_socket_settles_lost_and_cancel_settles_cancelled() {
    let Ok((socket, listener)) = listen() else {
        panic!("listen");
    };
    let path = socket.path().to_owned();
    let cancelled = AtomicBool::new(true);
    let refused = accept_one(socket, listener, &|| cancelled.load(Ordering::Acquire));
    assert_eq!(refused.err(), Some(NoConnection::Cancelled));
    // The socket path and its private directory are gone either way.
    assert!(!path.exists());
    assert!(path.parent().is_some_and(|dir| !dir.exists()));
}

#[test]
fn exits_deadlines_overflow_and_ssh_failures_are_typed() {
    assert!(matches!(
        run("echo out; echo err >&2; exit 65", 5, 64),
        StepRun::Exited { code: 65, ref stdout, ref stderr } if stdout == b"out\n" && stderr == b"err\n"
    ));
    assert!(matches!(run("sleep 5", 0, 64), StepRun::Unknown));
    assert!(matches!(run("sleep 5 & wait", 1, 64), StepRun::Unknown));
    assert!(matches!(
        run("head -c 2048 /dev/zero", 5, 1024),
        StepRun::Unknown
    ));
    assert!(matches!(
        run(
            "echo 'Connection closed by remote host' >&2; exit 255",
            5,
            64
        ),
        StepRun::Unknown
    ));
    assert!(matches!(
        run("echo 'Permission denied (publickey).' >&2; exit 255", 5, 64),
        StepRun::Refused(ErrorCode::AuthRequired)
    ));
    assert!(matches!(run("kill -9 $$", 5, 64), StepRun::Unknown));
}

#[test]
fn cancellation_kills_the_child_group() {
    let started = Instant::now();
    let outcome = run_backend_step(
        &mut shell("sleep 30"),
        Stdio::null(),
        Instant::now() + Duration::from_secs(30),
        64,
        || started.elapsed() > Duration::from_millis(100),
    );
    assert!(matches!(outcome, StepRun::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(5));
}
