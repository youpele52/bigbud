use super::wrap;
use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_gone(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn the_wrapped_command_keeps_its_exit_status_and_stdio() {
    let mut inner = Command::new("/bin/sh");
    inner.args(["-c", "read -r line; printf '%s\\n' \"$line\"; exit 7"]);
    let guarded = wrap(&inner).unwrap();
    let mut command = guarded.command;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    drop(command);
    drop(guarded.reader);
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), b"hello\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, b"hello\n");
    drop(guarded.owner_alive);
}

#[test]
fn closing_the_owner_end_kills_the_whole_group() {
    // The inner command records its own pid, then would sleep for a minute.
    let marker = std::env::temp_dir().join(format!(
        "bigbud-local-guard-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let mut inner = Command::new("/bin/sh");
    inner.args([
        "-c",
        &format!("echo $$ > '{}'; exec sleep 60", marker.display()),
    ]);
    let guarded = wrap(&inner).unwrap();
    let mut command = guarded.command;
    let mut child = command.stdin(Stdio::null()).spawn().unwrap();
    drop(command);
    drop(guarded.reader);
    let deadline = Instant::now() + Duration::from_secs(5);
    let inner_pid = loop {
        if let Some(pid) = std::fs::read_to_string(&marker)
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "inner command never started");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(alive(inner_pid));
    // Simulates owner death: the only write end closes.
    drop(guarded.owner_alive);
    assert!(wait_gone(inner_pid), "inner command outlived the owner");
    let _status = child.wait().unwrap();
    let _cleanup = std::fs::remove_file(&marker);
}
