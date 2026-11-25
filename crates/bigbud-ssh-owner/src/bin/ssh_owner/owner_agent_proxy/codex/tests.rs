use super::*;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::process::Command;

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const THREAD: &str = "proof-thread";
const EPOCH: u64 = 21;
const BINARY: &str = "/remote/bin/codex's $(exit 99)";
const CWD: &str = "/remote/work tree's $HOME";

#[test]
fn matches_only_the_exact_startup_binding() {
    let recipe = Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), THREAD, EPOCH).unwrap();
    assert!(recipe.matches_binding(BINARY, SHA, CWD, THREAD, EPOCH));
    for (bin, sha, cwd, thread, epoch) in [
        ("/remote/bin/codex", SHA, CWD, THREAD, EPOCH),
        (BINARY, &"a".repeat(64), CWD, THREAD, EPOCH),
        (BINARY, SHA, "/remote/work", THREAD, EPOCH),
        (BINARY, SHA, &format!("{CWD}/."), THREAD, EPOCH),
        (BINARY, SHA, CWD, "another-thread", EPOCH),
        (BINARY, SHA, CWD, THREAD, EPOCH + 1),
    ] {
        assert!(!recipe.matches_binding(bin, sha, cwd, thread, epoch));
    }
}

#[test]
fn rejects_malformed_startup_operands() {
    for name in [
        "",
        "/",
        "relative/codex",
        "//remote/codex",
        "/remote//codex",
        "/remote/./codex",
        "/remote/../codex",
        "/remote/codex/",
        "/remote/codex\n",
        "/remote/cod\0ex",
        &format!("/{}", "x".repeat(MAX_PATH_BYTES)),
    ] {
        assert!(Recipe::new(Path::new(name), SHA, Path::new(CWD), THREAD, EPOCH).is_err());
        assert!(Recipe::new(Path::new(BINARY), SHA, Path::new(name), THREAD, EPOCH).is_err());
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
fn produces_two_fixed_recipes_and_quotes_operands_as_data() {
    let recipe = Recipe::new(Path::new(BINARY), SHA, Path::new(CWD), THREAD, EPOCH).unwrap();
    for (command, verb) in [
        (recipe.probe_command(), "--version"),
        (recipe.command(), "app-server"),
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
            "bigbud-codex-proof",
            BINARY,
            SHA,
            CWD,
            &MAX_BINARY_BYTES.to_string(),
            verb,
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
    if (argc != 2 || !home || !locale || strcmp(locale, "C") ||
        !getcwd(cwd, sizeof cwd) || strcmp(cwd, home) ||
        getenv("PATH") || getenv("CODEX_HOME") || getenv("OPENAI_API_KEY") || getenv("BASH_ENV")) return 91;
    if (!strcmp(argv[1], "--version")) {
        puts("codex-cli 0.166.0");
        return 0;
    }
    if (strcmp(argv[1], "app-server")) return 92;
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
                "bigbud-codex-proof-{:x}",
                Sha256::digest(super::super::super::random_token().unwrap())
            ));
            let cwd = root.join("cwd's $(exit 99)");
            let bin = root.join("bin");
            let binary = bin.join("codex's $HOME");
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
            let built = Command::new("cc")
                .args(["-o"])
                .arg(&fixture.binary)
                .arg(source)
                .output()
                .unwrap();
            assert!(
                built.status.success(),
                "{}",
                String::from_utf8_lossy(&built.stderr)
            );
            fs::set_permissions(&fixture.binary, fs::Permissions::from_mode(0o500)).unwrap();
            fixture.sha = digest(&fixture.binary);
            fixture
        }

        fn recipe(&self, binary: &Path, sha: &str, cwd: &Path) -> Recipe {
            Recipe::new(binary, sha, cwd, THREAD, EPOCH).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _removed = fs::remove_dir_all(&self.root);
        }
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
                ("CODEX_HOME", "/unbound-codex"),
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
    fn linux_runs_only_the_pinned_fixture_and_preserves_streams_and_exit() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe(&fixture.binary, &fixture.sha, &fixture.cwd);
        let probe = run(recipe.probe_command()).output().unwrap();
        assert!(probe.status.success(), "{probe:?}");
        assert_eq!(probe.stdout, b"codex-cli 0.166.0\n");
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
    }

    #[test]
    fn linux_denies_digest_mismatch_and_inode_replacement() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe(&fixture.binary, &fixture.sha, &fixture.cwd);
        let wrong = fixture.recipe(&fixture.binary, SHA, &fixture.cwd);
        assert_denied(run(wrong.probe_command()).output().unwrap());

        fs::rename(&fixture.binary, fixture.root.join("original")).unwrap();
        fs::copy("/bin/true", &fixture.binary).unwrap();
        fs::set_permissions(&fixture.binary, fs::Permissions::from_mode(0o500)).unwrap();
        assert_denied(run(recipe.command()).output().unwrap());
    }

    #[test]
    fn linux_executes_the_verified_inode_after_the_name_is_atomically_replaced() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe(&fixture.binary, &fixture.sha, &fixture.cwd);
        let replacement = fixture.binary.with_file_name("replacement");
        fs::copy("/bin/true", &replacement).unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o500)).unwrap();

        // Test-only instrumentation replaces the name after the last digest and
        // metadata checks. A pathname-based exec would now run /bin/true.
        let instrumented = SCRIPT.replace(
            "validate 2>/dev/null || exit 126\n",
            "validate 2>/dev/null || exit 126\n/usr/bin/mv -f -- \"$parent_replacement\" \"$binary\" || exit 125\n",
        );
        let instrumented = format!(
            "parent_replacement={}\n{instrumented}",
            quote(replacement.to_str().unwrap()),
        );
        let command = recipe
            .probe_command()
            .replace(&quote(SCRIPT), &quote(&instrumented));
        assert_ne!(command, recipe.probe_command());
        let probe = run(&command).output().unwrap();
        assert!(probe.status.success(), "{probe:?}");
        assert_eq!(probe.stdout, b"codex-cli 0.166.0\n");
        assert_denied(run(recipe.probe_command()).output().unwrap());
    }

    #[test]
    fn linux_rejects_unsafe_binary_and_cwd_even_with_matching_digest() {
        let fixture = Fixture::new();
        let mut paths = Vec::new();
        let link = fixture.binary.with_file_name("codex-link");
        symlink(&fixture.binary, &link).unwrap();
        paths.push((link, fixture.sha.clone(), fixture.cwd.clone()));
        let alias = fixture.root.join("bin-link");
        symlink(fixture.binary.parent().unwrap(), &alias).unwrap();
        paths.push((
            alias.join(fixture.binary.file_name().unwrap()),
            fixture.sha.clone(),
            fixture.cwd.clone(),
        ));
        let cwd_link = fixture.root.join("cwd-link");
        symlink(&fixture.cwd, &cwd_link).unwrap();
        paths.push((fixture.binary.clone(), fixture.sha.clone(), cwd_link));
        let open_cwd = fixture.root.join("public-cwd");
        fs::create_dir(&open_cwd).unwrap();
        fs::set_permissions(&open_cwd, fs::Permissions::from_mode(0o755)).unwrap();
        paths.push((fixture.binary.clone(), fixture.sha.clone(), open_cwd));
        let script = fixture.binary.with_file_name("codex-script");
        fs::write(&script, b"#!/bin/sh\nprintf 'must not execute'\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o500)).unwrap();
        let script_sha = digest(&script);
        paths.push((script, script_sha, fixture.cwd.clone()));
        for (binary, sha, cwd) in paths {
            assert_denied(
                run(fixture.recipe(&binary, &sha, &cwd).probe_command())
                    .output()
                    .unwrap(),
            );
        }

        let recipe = fixture.recipe(&fixture.binary, &fixture.sha, &fixture.cwd);
        let extra_link = fixture.binary.with_file_name("codex-hardlink");
        fs::hard_link(&fixture.binary, &extra_link).unwrap();
        assert_denied(run(recipe.probe_command()).output().unwrap());
        fs::remove_file(extra_link).unwrap();
        symlink("missing-codex-home", fixture.cwd.join(".codex")).unwrap();
        assert_denied(run(recipe.probe_command()).output().unwrap());
    }

    #[test]
    fn linux_does_not_interpret_a_malformed_elf_as_shell() {
        let fixture = Fixture::new();
        let malformed = fixture.binary.with_file_name("malformed");
        fs::write(&malformed, b"\x7fELF\x02\x01\x01\0\nexit 0\n").unwrap();
        fs::set_permissions(&malformed, fs::Permissions::from_mode(0o500)).unwrap();
        let recipe = fixture.recipe(&malformed, &digest(&malformed), &fixture.cwd);
        let output = run(recipe.probe_command()).output().unwrap();
        assert_eq!(output.status.code(), Some(126));
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn linux_rejects_an_oversized_file_before_hashing() {
        let fixture = Fixture::new();
        let recipe = fixture.recipe(&fixture.binary, &fixture.sha, &fixture.cwd);
        // Tighten the compiled limit in the test so that even the hash's
        // bounded read would produce the exact admitted digest without the
        // earlier size check: the file is exactly one byte over the limit.
        let size = fs::metadata(&fixture.binary).unwrap().len();
        let prefix = recipe
            .probe_command()
            .strip_suffix(&format!(" {MAX_BINARY_BYTES} --version"))
            .unwrap();
        let command = format!("{prefix} {} --version", size - 1);
        assert_denied(run(&command).output().unwrap());
    }
}
