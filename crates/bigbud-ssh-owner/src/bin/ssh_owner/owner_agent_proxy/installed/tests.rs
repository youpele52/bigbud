use super::*;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::process::Command;

#[test]
fn recipe_shell_parses_only_fixed_command_and_bound_operands() {
    let binary = "/guest/agent's $(exit 99); *";
    let state = "/guest/state's $HOME; *";
    let hash = "a1".repeat(32);
    let recipe = Recipe::new(Path::new(binary), &hash, Path::new(state)).expect("binding");
    let command = recipe.command().strip_prefix("exec ").expect("fixed exec");
    // Exercise the same shell quoting without executing the recipe or a proxy.
    let output = Command::new("/bin/sh")
        .args(["-c", &format!("set -- {command}; printf '%s\\0' \"$@\"")])
        .output()
        .expect("shell parse");
    assert!(output.status.success());
    assert_eq!(
        output
            .stdout
            .strip_suffix(b"\0")
            .expect("terminator")
            .split(|b| *b == 0)
            .collect::<Vec<_>>(),
        [
            "/usr/bin/env",
            "-i",
            "LC_ALL=C",
            "/bin/bash",
            "-o",
            "pipefail",
            "-c",
            SCRIPT,
            "bigbud-agent-proxy",
            binary,
            &hash,
            state,
            &MAX_BINARY_BYTES.to_string(),
        ]
        .map(str::as_bytes),
    );
    assert_eq!(
        SCRIPT.lines().last(),
        Some("BIGBUD_AGENT_STATE_DIR=$state exec \"$fd\" --proxy"),
    );
    assert!(!SCRIPT.contains("--ephemeral"));
    assert!(!SCRIPT.contains("--supervisor"));
    assert!(
        Command::new("/bin/bash")
            .env_clear()
            .args(["-n", "-c", SCRIPT])
            .status()
            .expect("check Bash syntax")
            .success()
    );
}

#[test]
fn rejects_nonexact_paths_and_invalid_digests() {
    let binary = Path::new("/guest/install/agent");
    let state = Path::new("/guest/state");
    let hash = "a".repeat(64);
    for path in [
        Path::new(""),
        Path::new("/"),
        Path::new("relative/agent"),
        Path::new("//guest/agent"),
        Path::new("/guest//agent"),
        Path::new("/guest/./agent"),
        Path::new("/guest/../agent"),
        Path::new("/guest/agent/"),
        Path::new("/guest/agent\n"),
        Path::new("/guest/state\0"),
        Path::new(OsStr::from_bytes(b"/guest/\xff")),
    ] {
        assert!(Recipe::new(path, &hash, state).is_err(), "{path:?}");
        assert!(Recipe::new(binary, &hash, path).is_err(), "{path:?}");
    }
    for invalid in ["a".repeat(63), "A".repeat(64), "'".repeat(64)] {
        assert!(Recipe::new(binary, &invalid, state).is_err());
    }
}

#[test]
fn bounds_binary_and_supervisor_socket_paths_by_byte_length() {
    let binary = Path::new("/guest/install/agent");
    let hash = "a".repeat(64);
    let state_at_limit = format!("/{}", "é".repeat((MAX_STATE_BYTES - 1) / 2));
    assert_eq!(state_at_limit.len(), MAX_STATE_BYTES);
    assert!(Recipe::new(binary, &hash, Path::new(&state_at_limit)).is_ok());
    assert!(Recipe::new(binary, &hash, Path::new(&(state_at_limit + "x"))).is_err());
    let oversized = format!("/{}", "a".repeat(MAX_PATH_BYTES));
    assert!(Recipe::new(Path::new(&oversized), &hash, Path::new("/guest/state")).is_err());
}
