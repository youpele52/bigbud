#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use bigbud_remote_agent::backend_service::run_bounded_service_command;
use std::os::unix::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const BINARY: &str = env!("CARGO_BIN_EXE_bigbud-remote-agent");
static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-service-command-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn command(script: &str, sentinel: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .args(["-c", script, "service-fixture"])
        .arg(sentinel);
    command
}
fn run(
    command: Command,
    timeout: Duration,
    maximum: usize,
) -> bigbud_remote_agent::backend_service::Result<(String, u8)> {
    run_bounded_service_command(command, timeout, maximum, Path::new(BINARY))
}
#[test]
fn deadline_and_overflow_settle_descendants_before_their_late_write() {
    for script in [
        r#"(sleep .3; printf late > "$1") & sleep 10"#,
        r#"(sleep .3; printf late > "$1") & while :; do printf overflowing; done"#,
    ] {
        let fixture = Fixture::new();
        let sentinel = fixture.0.join("late-write");
        let began = Instant::now();
        assert!(run(command(script, &sentinel), Duration::from_millis(100), 1024).is_err());
        assert!(began.elapsed() < Duration::from_secs(4));
        std::thread::sleep(Duration::from_millis(450));
        assert!(!sentinel.exists());
    }
}
#[test]
fn success_cleans_background_descendants_even_with_closed_output() {
    let fixture = Fixture::new();
    let sentinel = fixture.0.join("late-write");
    let result = run(
        command(
            r#"(exec 1>&- 2>&-; sleep .3; printf late > "$1") & printf done"#,
            &sentinel,
        ),
        Duration::from_secs(2),
        1024,
    )
    .unwrap();
    assert_eq!(result, ("done".into(), 0));
    std::thread::sleep(Duration::from_millis(450));
    assert!(!sentinel.exists());
}
#[test]
fn status_environment_and_argument_boundaries_are_preserved() {
    let fixture = Fixture::new();
    let mut child = command(
        r#"printf '%s:%s' "$1" "$PRIVATE_TEST_VALUE"; exit 17"#,
        &fixture.0,
    );
    child.env("PRIVATE_TEST_VALUE", "literal value");
    let result = run(child, Duration::from_secs(2), 1024).unwrap();
    assert_eq!(
        result,
        (format!("{}:literal value", fixture.0.display()), 17)
    );
}
#[test]
#[ignore = "exact subprocess helper for backend SIGKILL regression"]
fn backend_owner_helper() {
    let sentinel = PathBuf::from(std::env::var_os("BIGBUD_COMMAND_SENTINEL").unwrap());
    let mut child = command(
        r#"(exec 1>&- 2>&-; printf ready > "$2"; while ! test -e "$3"; do sleep .005; done; printf late > "$1") & sleep 10"#,
        &sentinel,
    );
    child
        .arg(sentinel.with_extension("ready"))
        .arg(sentinel.with_extension("gate"));
    let result = run(child, Duration::from_secs(5), 1024);
    panic!("backend owner unexpectedly returned: {result:?}");
}
#[test]
fn backend_death_prevents_a_write_authorized_only_after_owner_reap() {
    for iteration in 0..12 {
        let fixture = Fixture::new();
        let sentinel = fixture.0.join("late-write");
        let ready = sentinel.with_extension("ready");
        let gate = sentinel.with_extension("gate");
        let mut backend = Command::new(std::env::current_exe().unwrap())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("BIGBUD_COMMAND_SENTINEL", &sentinel)
            .process_group(0)
            .args(["--exact", "backend_owner_helper", "--ignored"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        let prepared = ready.exists();
        if iteration % 2 == 0 {
            backend.kill().unwrap();
        } else {
            // SAFETY: this direct unreaped child owns its dedicated group; the test stays
            // outside it. Its monitor must survive outer caller-group cancellation.
            assert_eq!(
                unsafe { libc::kill(-(backend.id() as i32), libc::SIGKILL) },
                0
            );
        }
        backend.wait().unwrap();
        assert!(prepared, "helper failed to reach owned command");
        assert!(!sentinel.exists());
        // The writer cannot act until after the backend has actually died and been reaped.
        // Allow the monitor's bounded EOF cancellation to settle before enabling the gate.
        std::thread::sleep(Duration::from_millis(80));
        fs::write(&gate, b"after-owner-reap").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !sentinel.exists(),
            "owned descendant survived owner-death cleanup"
        );
    }
}
#[test]
fn private_worker_refuses_a_missing_owner_socket_before_execution() {
    let fixture = Fixture::new();
    let sentinel = fixture.0.join("must-not-run");
    let result = Command::new(BINARY)
        .args([
            "--backend-service-command-monitor",
            "1000",
            "/usr/bin/touch",
        ])
        .arg(&sentinel)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!result.success());
    assert!(!sentinel.exists());
}
