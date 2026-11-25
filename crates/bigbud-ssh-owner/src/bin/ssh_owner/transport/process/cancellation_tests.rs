use super::*;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn picker_cancelled_before_launch_does_not_try_to_spawn() {
    let command = Command::new(""); // Would fail to spawn without cancellation.
    assert!(matches!(
        run_picker_cancellable(command, Instant::now() + Duration::from_secs(3), 32, || {
            true
        }),
        Err(PickerFailure::Cancelled)
    ));
}

#[test]
fn picker_without_cancellation_retains_its_timeout_and_capture_limit() {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf abcdef; printf warning >&2"]);
    let Ok(output) = run_picker_cancellable(command, deadline, 3, || false) else {
        panic!("fixture command should complete");
    };
    assert!(output.status.success());
    assert_eq!(output.stdout, b"abc");
    assert_eq!(output.stderr, b"warning");
    assert!(output.truncated);

    let mut command = Command::new("/bin/sleep");
    command.arg("30");
    assert!(matches!(
        run_picker_cancellable(
            command,
            Instant::now() + Duration::from_millis(100),
            32,
            || false
        ),
        Err(PickerFailure::Process(Failure::TimedOut))
    ));
}

#[test]
fn picker_cancels_during_busy_drain_and_reaps_its_own_group_only() {
    let dir = TempDir::new();
    let ready = dir.0.join("ready");
    let mut sibling = Sibling(
        Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn unrelated fixture group"),
    );
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            // The descendant keeps both pipes open without writing to either,
            // so merely closing the pipes can't kill it with SIGPIPE.
            "/bin/sleep 5 & printf '%s %s\\n' \"$$\" \"$!\" > \"$1\"; while :; do printf 'a busy output stream\\n'; printf 'a busy error stream\\n' >&2; done",
            "fixture-picker",
        ])
        .arg(&ready);
    let started = std::cell::Cell::new(0);
    let result =
        run_picker_cancellable(command, Instant::now() + Duration::from_secs(5), 32, || {
            // Observe a real launch, then let multiple bounded drain iterations
            // run before requesting cancellation even though the output is busy.
            let count = started.get();
            if count != 0 || read_pids(&ready).is_some() {
                started.set(count + 1);
            }
            started.get() > 8
        });
    assert!(matches!(result, Err(PickerFailure::Cancelled)));
    let (leader, descendant) = read_pids(&ready).expect("fixture wrote owned process IDs");
    assert!(!pid_exists(leader), "owned leader was not reaped: {leader}");
    let deadline = Instant::now() + REAP_GRACE;
    while Instant::now() < deadline && pid_running(descendant) {
        thread::sleep(POLL_INTERVAL);
    }
    assert!(
        !pid_running(descendant),
        "owned descendant survived: {descendant}"
    );
    assert!(
        sibling
            .0
            .try_wait()
            .expect("inspect unrelated fixture")
            .is_none()
    );
}

fn read_pids(path: &Path) -> Option<(i32, i32)> {
    let text = fs::read_to_string(path).ok()?;
    if !text.ends_with('\n') {
        return None;
    }
    let (leader, descendant) = text.trim_end().split_once(' ')?;
    Some((leader.parse().ok()?, descendant.parse().ok()?))
}

fn pid_exists(pid: i32) -> bool {
    assert!(pid > 0);
    // SAFETY: signal zero only checks the existence of the positive fixture PID.
    (unsafe { libc::kill(pid, 0) }) == 0
}

fn pid_running(pid: i32) -> bool {
    if !pid_exists(pid) {
        return false;
    }
    // An orphaned descendant may still have a PID while awaiting reaping by
    // init. Require that it is no longer executing, not that init ran already.
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("inspect fixture descendant state");
    let state = String::from_utf8(output.stdout).expect("ps state is ASCII");
    !(state.trim_start().starts_with('Z') || state.trim().is_empty() && !pid_exists(pid))
}

struct Sibling(Child);

impl Drop for Sibling {
    fn drop(&mut self) {
        teardown(&mut self.0);
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bigbud-picker-cancel-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("create fixture directory");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove fixture directory");
    }
}
