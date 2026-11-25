use super::*;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::process::Command;

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const THREAD: &str = "proof-thread";
const EPOCH: u64 = 21;
const BINARY: &str = "/remote/bin/pi's $(exit 99)";
const CWD: &str = "/remote/work tree's $HOME";

#[test]
fn requires_the_exact_startup_binding_and_refuses_session_files() {
    let recipe = Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), THREAD, EPOCH).unwrap();
    assert!(recipe.matches_binding(BINARY, SHA, CWD, THREAD, EPOCH, None));
    let other_hash = "a".repeat(64);
    let alias = format!("{CWD}/.");
    for (binary, sha, cwd, thread, epoch, session) in [
        ("/remote/bin/pi", SHA, CWD, THREAD, EPOCH, None),
        (BINARY, &other_hash, CWD, THREAD, EPOCH, None),
        (BINARY, SHA, "/remote/work", THREAD, EPOCH, None),
        (BINARY, SHA, &alias, THREAD, EPOCH, None),
        (BINARY, SHA, CWD, "another-thread", EPOCH, None),
        (BINARY, SHA, CWD, THREAD, EPOCH + 1, None),
        (
            BINARY,
            SHA,
            CWD,
            THREAD,
            EPOCH,
            Some("/private/resume.jsonl"),
        ),
        (BINARY, SHA, CWD, THREAD, EPOCH, Some("")),
    ] {
        assert!(!recipe.matches_binding(binary, sha, cwd, thread, epoch, session));
    }
}

#[test]
fn rejects_noncanonical_paths_and_invalid_binding_fields() {
    for operand in [
        "",
        "/",
        "relative/pi",
        "//remote/pi",
        "/remote//pi",
        "/remote/./pi",
        "/remote/../pi",
        "/remote/pi/",
        "/remote/pi\n",
        "/remote/pi\0",
        &format!("/{}", "x".repeat(MAX_PATH_BYTES)),
    ] {
        assert!(Recipe::new(Path::new(operand), SHA, Path::new(CWD), THREAD, EPOCH).is_err());
        assert!(Recipe::new(Path::new(BINARY), SHA, Path::new(operand), THREAD, EPOCH).is_err());
    }
    let non_utf8 = Path::new(OsStr::from_bytes(b"/remote/\xff"));
    assert!(Recipe::new(non_utf8, SHA, Path::new(CWD), THREAD, EPOCH).is_err());
    for sha in ["", &"a".repeat(63), &SHA.to_uppercase(), &"g".repeat(64)] {
        assert!(Recipe::new(Path::new(BINARY), sha, Path::new(CWD), THREAD, EPOCH).is_err());
    }
    for thread in ["", "a b", "a\n", "ä", &"x".repeat(129)] {
        assert!(Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), thread, EPOCH).is_err());
    }
}

#[test]
fn emits_only_fixed_actions_with_quoted_operands_and_cleared_environment() {
    let recipe = Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), THREAD, EPOCH).unwrap();
    for (command, action) in [
        (recipe.probe_command(), "probe"),
        (recipe.command(), "start"),
    ] {
        let argv = command.strip_prefix("exec ").unwrap();
        let parsed = Command::new("/bin/sh")
            .env_clear()
            .args(["-c", &format!("set -- {argv}; printf '%s\\0' \"$@\"")])
            .output()
            .unwrap();
        assert!(parsed.status.success());
        let expected = [
            "/usr/bin/env",
            "-i",
            "LC_ALL=C",
            "/bin/bash",
            "-o",
            "pipefail",
            "-c",
            SCRIPT,
            "bigbud-pi-proof",
            BINARY,
            SHA,
            CWD,
            &MAX_BINARY_BYTES.to_string(),
            action,
        ];
        assert_eq!(parsed.stdout, (expected.join("\0") + "\0").into_bytes());
    }
    assert!(
        Command::new("/bin/bash")
            .env_clear()
            .args(["-n", "-c", SCRIPT])
            .status()
            .unwrap()
            .success()
    );
}

#[cfg(not(target_os = "linux"))]
#[test]
fn fails_closed_outside_linux() {
    let recipe = Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), THREAD, EPOCH).unwrap();
    for command in [recipe.probe_command(), recipe.command()] {
        let output = Command::new("/bin/sh")
            .env_clear()
            .args(["-c", command])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(126));
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
    use std::path::PathBuf;
    use std::process::{Output, Stdio};

    const PAYLOAD: &[u8] = b"\x00\x80\xff\n";
    const FIXTURE: &str = r#"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
    char cwd[4096];
    const char *home = getenv("HOME"), *locale = getenv("LC_ALL");
    if (!home || !locale || strcmp(locale, "C") || !getcwd(cwd, sizeof cwd) ||
        strcmp(cwd, home) || getenv("PATH") || getenv("PI_CODING_AGENT_DIR") ||
        getenv("OPENAI_API_KEY") || getenv("BASH_ENV")) return 91;
    if (argc == 2 && !strcmp(argv[1], "--version")) {
        puts("1.4.0");
        return 0;
    }
    if (argc != 3 || strcmp(argv[1], "--mode") || strcmp(argv[2], "rpc")) return 92;
    fputs("fixture stderr\n", stderr);
    int byte;
    while ((byte = getchar()) != EOF) if (putchar(byte) == EOF) return 93;
    return ferror(stdin) ? 94 : 7;
}
"#;

    struct Fixture {
        root: PathBuf,
        binary: PathBuf,
        cwd: PathBuf,
        sha: String,
    }

    impl Fixture {
        fn new() -> Self {
            let root = Path::new("/tmp").join(format!(
                "bigbud-pi-proof-{:x}",
                Sha256::digest(super::super::super::random_token().unwrap())
            ));
            let cwd = root.join("cwd's $(exit 99)");
            let bin = root.join("bin");
            let binary = bin.join("pi's $HOME");
            for dir in [&root, &cwd, &bin] {
                fs::DirBuilder::new().mode(0o700).create(dir).unwrap();
            }
            let mut fixture = Self {
                root,
                binary,
                cwd,
                sha: String::new(),
            };
            let source = fixture.root.join("fixture.c");
            fs::write(&source, FIXTURE).unwrap();
            let build = Command::new("cc")
                .arg("-o")
                .arg(&fixture.binary)
                .arg(source)
                .output()
                .unwrap();
            assert!(
                build.status.success(),
                "{}",
                String::from_utf8_lossy(&build.stderr)
            );
            private_executable(&fixture.binary);
            fixture.sha = digest(&fixture.binary);
            fixture
        }

        fn recipe(&self) -> Recipe {
            Recipe::new(&self.binary, &self.sha, &self.cwd, THREAD, EPOCH).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _removed = fs::remove_dir_all(&self.root);
        }
    }

    fn private_executable(path: &Path) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
    }

    fn digest(path: &Path) -> String {
        format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
    }

    fn run(command: &str) -> Command {
        let mut shell = Command::new("/bin/sh");
        shell
            .env_clear()
            .envs([
                ("HOME", "/unbound"),
                ("PI_CODING_AGENT_DIR", "/unbound-pi"),
                ("OPENAI_API_KEY", "fake-key-not-credentials"),
                ("BASH_ENV", "/unbound-bash-env"),
            ])
            .args(["-c", command]);
        shell
    }

    fn assert_denied(output: Output) {
        assert_eq!(output.status.code(), Some(126), "{output:?}");
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn probes_version_and_preserves_rpc_streams_and_exit_status() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe();
        let probe = run(recipe.probe_command()).output().unwrap();
        assert!(probe.status.success(), "{probe:?}");
        assert_eq!(probe.stdout, b"1.4.0\n");
        assert!(probe.stderr.is_empty());

        let mut child = run(recipe.command())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(PAYLOAD).unwrap();
        let start = child.wait_with_output().unwrap();
        assert_eq!(start.status.code(), Some(7), "{start:?}");
        assert_eq!(start.stdout, PAYLOAD);
        assert_eq!(start.stderr, b"fixture stderr\n");
        let with_extra = format!("{} --session ignored", recipe.command());
        assert_denied(run(&with_extra).output().unwrap());
    }

    #[test]
    fn executes_the_verified_inode_after_atomic_path_replacement() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe();
        let replacement = fixture.binary.with_file_name("replacement");
        fs::copy("/bin/true", &replacement).unwrap();
        private_executable(&replacement);

        // Instrument only the test command to replace the path after hashing.
        let check = "validate 2>/dev/null || exit 126\n";
        let instrumented = SCRIPT.replace(
            check,
            &format!(
                "{check}/usr/bin/mv -f -- {} \"$binary\" || exit 125\n",
                quote(replacement.to_str().unwrap()),
            ),
        );
        let command = recipe
            .probe_command()
            .replace(&quote(SCRIPT), &quote(&instrumented));
        assert_ne!(command, recipe.probe_command());
        let probe = run(&command).output().unwrap();
        assert!(probe.status.success(), "{probe:?}");
        assert_eq!(probe.stdout, b"1.4.0\n");
        assert_denied(run(recipe.command()).output().unwrap());
    }

    #[test]
    fn denies_unsafe_executables_workdirs_and_pi_config() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe();
        let executable_link = fixture.binary.with_file_name("pi-link");
        symlink(&fixture.binary, &executable_link).unwrap();
        let script = fixture.binary.with_file_name("pi-script");
        fs::write(&script, b"#!/bin/sh\nprintf 'must not execute'\n").unwrap();
        private_executable(&script);
        let cwd_link = fixture.root.join("cwd-link");
        symlink(&fixture.cwd, &cwd_link).unwrap();
        let public_cwd = fixture.root.join("public");
        fs::create_dir(&public_cwd).unwrap();
        fs::set_permissions(&public_cwd, fs::Permissions::from_mode(0o755)).unwrap();
        let script_sha = digest(&script);
        for (binary, sha, cwd) in [
            (&executable_link, fixture.sha.as_str(), &fixture.cwd),
            (&script, script_sha.as_str(), &fixture.cwd),
            (&fixture.binary, fixture.sha.as_str(), &cwd_link),
            (&fixture.binary, fixture.sha.as_str(), &public_cwd),
            (&fixture.binary, SHA, &fixture.cwd),
        ] {
            let denied = Recipe::new(binary, sha, cwd, THREAD, EPOCH).unwrap();
            assert_denied(run(denied.probe_command()).output().unwrap());
        }
        for config in [".pi", ".agents"] {
            let path = fixture.cwd.join(config);
            symlink("missing-config", &path).unwrap();
            assert_denied(run(recipe.command()).output().unwrap());
            fs::remove_file(path).unwrap();
        }
        let hardlink = fixture.binary.with_file_name("pi-hardlink");
        fs::hard_link(&fixture.binary, hardlink).unwrap();
        assert_denied(run(recipe.probe_command()).output().unwrap());
    }

    #[test]
    fn refuses_shell_fallback_and_rejects_a_file_one_byte_over_the_limit() {
        let fixture = Fixture::new();
        let malformed = fixture.binary.with_file_name("malformed-elf");
        fs::write(&malformed, b"\x7fELF\x02\x01\x01\0\nexit 0\n").unwrap();
        private_executable(&malformed);
        let malformed =
            Recipe::new(&malformed, &digest(&malformed), &fixture.cwd, THREAD, EPOCH).unwrap();
        let output = run(malformed.probe_command()).output().unwrap();
        assert_eq!(output.status.code(), Some(126));
        assert!(output.stdout.is_empty());

        let recipe = fixture.recipe();
        // Use the real hash with a tighter bound to exercise the size check
        // without allocating a 128 MiB fixture.
        let size = fs::metadata(&fixture.binary).unwrap().len();
        let prefix = recipe
            .probe_command()
            .strip_suffix(&format!(" {MAX_BINARY_BYTES} probe"))
            .unwrap();
        let command = format!("{prefix} {} probe", size - 1);
        assert_denied(run(&command).output().unwrap());
    }
}
