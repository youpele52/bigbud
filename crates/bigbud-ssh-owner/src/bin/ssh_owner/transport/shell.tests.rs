use super::*;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
    fn new(label: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("bigbud-owner-shell-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .expect("create fixture");
        Self(root.canonicalize().expect("physical fixture"))
    }

    fn root(&self) -> &str {
        self.0.to_str().expect("UTF-8 fixture")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn local(command: &str) -> std::process::Output {
    std::process::Command::new("/bin/sh")
        .args(["-c", command])
        .output()
        .expect("local fixture shell")
}

#[test]
fn timeout_bounds_keep_the_thread_shell_default_and_ceiling() {
    assert_eq!(bounded_timeout(0), DEFAULT_TIMEOUT_MS);
    assert_eq!(bounded_timeout(1), 1);
    assert_eq!(bounded_timeout(60_000), 60_000);
    assert_eq!(bounded_timeout(u32::MAX), MAX_TIMEOUT_MS);
}

#[test]
fn identity_and_command_bounds_refuse_empty_nul_and_oversize() {
    assert_eq!(validate_identity("thread-1"), Ok(()));
    assert_eq!(validate_identity(""), Err(ErrorCode::InvalidOperands));
    assert_eq!(validate_identity("a\0b"), Err(ErrorCode::InvalidOperands));
    assert_eq!(
        validate_identity(&"x".repeat(MAX_IDENTITY_BYTES + 1)),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(validate_command("printf ok"), Ok(()));
    assert_eq!(validate_command(""), Err(ErrorCode::InvalidOperands));
    assert_eq!(validate_command("a\0b"), Err(ErrorCode::InvalidOperands));
    assert_eq!(
        validate_command(&"x".repeat(MAX_COMMAND_BYTES + 1)),
        Err(ErrorCode::InvalidOperands)
    );
}

#[test]
fn shell_recipe_runs_the_exact_command_text_and_binds_cwd() {
    let fixture = Fixture::new("recipe");
    let nested = fixture.0.join("thread dir");
    fs::create_dir(&nested).unwrap();
    let relative = "thread dir";
    // The owner-selected shell receives the accepted text as one positional
    // argument, so metacharacters are data, not a caller-supplied program.
    let command = "printf '%s\\n' \"$PWD\"; printf '%s\\n' 'a;b$(c)'";
    let (script, _) = shell_command(fixture.root(), relative, command, 30_000);
    let output = local(&script);
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.starts_with(&format!("{}\n", nested.to_str().unwrap())));
    assert!(text.contains("a;b$(c)\n"));
}

#[test]
fn shell_recipe_refuses_a_cwd_outside_the_workspace() {
    let fixture = Fixture::new("outside");
    let (script, _) = shell_command(fixture.root(), "../outside", "true", 30_000);
    let output = local(&script);
    assert_eq!(output.status.code(), Some(3));
}

#[test]
fn acp_recipe_prints_the_physical_workspace_only() {
    let fixture = Fixture::new("acp");
    let script = workspace_command_with_arg(ACP_RECIPE, fixture.root(), "", "");
    let output = local(&script);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", fixture.root())
    );
}

#[test]
fn timeout_is_typed_and_reaps_the_owner_selected_shell() {
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30"]);
    command.process_group(0);
    let failure = match process::run_with_combined_output_limit(
        command,
        std::time::Instant::now() + Duration::from_millis(100),
        1024,
    ) {
        Err(failure) => failure,
        Ok(_) => panic!("a bounded shell must time out"),
    };
    assert_eq!(
        match failure {
            process::Failure::TimedOut => ErrorCode::ShellTimedOut,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io => ErrorCode::TransportLost,
        },
        ErrorCode::ShellTimedOut
    );
}

/// Regression: under dash (Debian `/bin/sh`) the guarded command used to get
/// `/dev/null` instead of the caller's stdin, starving provider leases.
#[test]
fn the_session_guard_keeps_the_callers_stdin_under_posix_sh() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let script = concat!(include_str!("session_guard.sh"), "\nsession_guard 0 cat\n");
    let mut child = Command::new("/bin/sh")
        .args(["-c", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sh");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"through\n")
        .expect("write");
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success());
    assert_eq!(output.stdout, b"through\n");
}
