use super::super::tests::Fixture;
use super::*;
use std::fs;
use std::os::unix::{fs::symlink, process::ExitStatusExt};
use std::path::Path;
use std::process::{Command, ExitStatus, Output};

pub(super) fn git(root: &Path, args: &[&str]) -> Output {
    Command::new("/usr/bin/git")
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .env("HOME", "/dev/null")
        .env("XDG_CONFIG_HOME", "/dev/null")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .expect("run fixture Git command")
}

pub(super) fn setup(root: &Path, args: &[&str]) {
    let output = git(root, args);
    assert!(output.status.success(), "{:?}", output);
}

pub(super) fn init(root: &Path) {
    setup(root, &["init", "-q", "--template=", "-b", "proof"]);
}

pub(super) fn local(root: &Path, recipe: Recipe) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    local_with(root, recipe, &[])
}

pub(super) fn local_with(
    root: &Path,
    recipe: Recipe,
    paths: &[String],
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let mut cmd = Command::new("/bin/sh");
    let remote = recipe.command(root.to_str().unwrap(), paths);
    // Exercise the same shell recipe without OpenSSH or ambient Git settings.
    cmd.args([
        "-c",
        &format!("export GIT_DIR=/dev/null GIT_WORK_TREE=/dev/null GIT_CONFIG_COUNT=99; {remote}"),
    ]);
    let (timeout, cap) = recipe.limits();
    let output = process::run_with_combined_output_limit(cmd, Instant::now() + timeout, 2 * cap)
        .map_err(|_| "local recipe failed")
        .unwrap();
    decode(output, cap)
}

#[test]
fn exact_git_output_in_disposable_repo() {
    let fixture = Fixture::new();
    let root = fixture.0.join("repo '$(exit 9)'\n");
    fs::create_dir(&root).unwrap();
    init(&root);
    setup(&root, &["config", "user.name", "Fixture"]);
    setup(&root, &["config", "user.email", "fixture@example.test"]);
    let tracked = root.join("tracked\t雪");
    fs::write(&tracked, b"initial\n").unwrap();
    setup(&root, &["add", "--", "tracked\t雪"]);
    setup(&root, &["commit", "-qm", "initial"]);
    fs::write(&tracked, b"unstaged change\n").unwrap();
    fs::write(root.join(".gitignore"), "ignored\n").unwrap();
    fs::write(root.join("ignored"), []).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/untracked\nfile"), []).unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();

    for (recipe, args) in [
        (
            Recipe::Status,
            &["status", "--porcelain=2", "--branch", "-uall"][..],
        ),
        (
            Recipe::InsideWorkTree,
            &["rev-parse", "--is-inside-work-tree"],
        ),
    ] {
        let expected = git(&root, args);
        assert!(expected.status.success(), "{:?}", expected);
        let actual = local(&root, recipe).unwrap();
        assert_eq!(actual.code, expected.status.code());
        assert_eq!(actual.stdout.as_bytes(), expected.stdout);
        assert_eq!(actual.stderr.as_bytes(), expected.stderr);
    }
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}

#[test]
fn ordinary_nonzero_exits_without_discovering_parent() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    init(&fixture.0);
    let root = fixture.0.join("not-a-repo");
    fs::create_dir(&root).unwrap();
    for (recipe, args) in [
        (
            Recipe::Status,
            &["status", "--porcelain=2", "--branch", "-uall"][..],
        ),
        (
            Recipe::InsideWorkTree,
            &["rev-parse", "--is-inside-work-tree"],
        ),
    ] {
        let expected = git(&outside.0, args);
        let result = local(&root, recipe).unwrap();
        assert_eq!(result.code, Some(128));
        assert_eq!(result.code, expected.status.code());
        assert_eq!(result.stdout.as_bytes(), expected.stdout);
        assert_eq!(result.stderr.as_bytes(), expected.stderr);
    }
}

#[test]
fn refuses_unsupported_metadata_without_git_output() {
    let fixture = Fixture::new();
    let root = &fixture.0;
    init(root);
    for (key, value) in [
        ("include.path", "fixture-include"),
        ("core.fsmonitor", "false"),
        ("core.worktree", "."),
        ("core.excludesFile", "fixture-exclude"),
        ("filter.unsafe.process", "unsupported"),
    ] {
        let config = fs::read(root.join(".git/config")).unwrap();
        setup(root, &["config", key, value]);
        assert_eq!(
            local(root, Recipe::Status),
            Err(ErrorCode::WorkspaceReadFailed)
        );
        fs::write(root.join(".git/config"), config).unwrap();
    }
    fs::create_dir_all(root.join(".git/objects/info")).unwrap();
    for path in [
        ".git/commondir",
        ".git/objects/info/alternates",
        ".gitmodules",
    ] {
        fs::write(root.join(path), b"unused\n").unwrap();
        assert_eq!(
            local(root, Recipe::Status),
            Err(ErrorCode::WorkspaceReadFailed)
        );
        fs::remove_file(root.join(path)).unwrap();
    }
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/.git"), b"gitdir: elsewhere\n").unwrap();
    assert_eq!(
        local(root, Recipe::Status),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}

#[test]
fn rejects_symlinks_and_index_gitlinks() {
    let fixture = Fixture::new();
    let root = fixture.0.join("repo");
    fs::create_dir(&root).unwrap();
    init(&root);
    let linked = fixture.0.join("linked");
    symlink(&root, &linked).unwrap();
    assert_eq!(
        local(&linked, Recipe::Status),
        Err(ErrorCode::WorkspacePathDenied)
    );
    symlink(&fixture.0, root.join(".gitignore")).unwrap();
    assert_eq!(
        local(&root, Recipe::Status),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    fs::remove_file(root.join(".gitignore")).unwrap();
    symlink(
        fixture.0.join("elsewhere"),
        root.join(".git/refs/heads/proof"),
    )
    .unwrap();
    assert_eq!(
        local(&root, Recipe::InsideWorkTree),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    fs::remove_file(root.join(".git/refs/heads/proof")).unwrap();
    setup(
        &root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,1111111111111111111111111111111111111111,nested",
        ],
    );
    assert_eq!(
        local(&root, Recipe::Status),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}

#[test]
fn decodes_byte_limits_and_transport_errors_fail_closed() {
    let output = |code, stdout: &[u8], stderr: &[u8], truncated| process::Output {
        status: ExitStatus::from_raw(code << 8),
        stdout: stdout.into(),
        stderr: stderr.into(),
        truncated,
    };
    assert!(decode(output(128, b"1234", b"5678", false), 4).is_ok());
    for over in [
        output(0, b"12345", b"", false),
        output(0, b"", b"12345", false),
        output(0, b"1234", b"5678", true),
    ] {
        assert_eq!(decode(over, 4), Err(ErrorCode::WorkspaceReadFailed));
    }
    assert_eq!(
        decode(output(255, b"", b"Host key verification failed", false), 64),
        Err(ErrorCode::HostKeyChanged)
    );
    assert_eq!(
        decode(
            output(255, b"", b"Permission denied (publickey).", false),
            64
        ),
        Err(ErrorCode::AuthRequired)
    );
    assert_eq!(
        decode(output(255, b"", b"Connection closed", false), 64),
        Err(ErrorCode::TransportLost)
    );
    let result = decode(output(0, b"\xef\xbb\xbf\xff", b"\r\n", false), 4).unwrap();
    assert_eq!(result.stdout, "\u{fffd}");
    assert_eq!(result.stderr, "\r\n");
}

#[test]
fn fixes_action_and_limits_before_launch() {
    assert_eq!(
        Recipe::Status.limits(),
        (Duration::from_secs(30), 1_000_000)
    );
    assert_eq!(
        Recipe::InsideWorkTree.limits(),
        (Duration::from_secs(5), 4096)
    );
    for action in [0, -1, 127] {
        assert!(matches!(
            Recipe::from_action(action),
            Err(ErrorCode::InvalidOperands)
        ));
    }
    let fixture = Fixture::new();
    assert_eq!(
        validate_path(Some(&fixture.0), fixture.root(), "", true),
        Ok(fixture.root())
    );
    assert_eq!(
        validate_path(
            Some(&fixture.0),
            &format!("{}/other", fixture.root()),
            "",
            true
        ),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn mutations_reject_raw_operands_and_absolute_paths() {
    for (action, paths) in [
        (Recipe::RestoreTrackedPaths, vec![]),
        (
            Recipe::RestoreTrackedPaths,
            vec!["--force".to_string(), "tracked.txt".to_string()],
        ),
        (Recipe::CleanUntrackedPaths, vec!["/etc/passwd".to_string()]),
        (Recipe::StagePaths, vec!["../outside.txt".to_string()]),
        (Recipe::StagePaths, vec!["nested\\windows.txt".to_string()]),
        (Recipe::StagePaths, vec!["nul\0byte".to_string()]),
        (Recipe::Status, vec!["stray".to_string()]),
    ] {
        assert_eq!(
            validate_paths(action, &paths),
            Err(ErrorCode::InvalidOperands),
            "{action:?} {paths:?}"
        );
    }
    assert_eq!(
        validate_paths(
            Recipe::StagePaths,
            &["nested/file name.txt".to_string(), "other.txt".to_string()]
        ),
        Ok(())
    );
}

#[test]
fn mutation_recipes_preserve_exact_bytes_and_refs() {
    let fixture = Fixture::new();
    let root = fixture.0.join("repo");
    fs::create_dir(&root).unwrap();
    init(&root);
    setup(&root, &["config", "user.name", "Fixture"]);
    setup(&root, &["config", "user.email", "fixture@example.test"]);
    let tracked = root.join("tracked file.txt");
    fs::write(&tracked, b"original\n").unwrap();
    setup(&root, &["add", "--", "tracked file.txt"]);
    setup(&root, &["commit", "-qm", "initial"]);
    let head = git(&root, &["rev-parse", "HEAD"]).stdout;

    // Stage a new file with the fixed `add --` recipe.
    fs::write(root.join("staged.txt"), b"staged\n").unwrap();
    let stage = local_with(&root, Recipe::StagePaths, &["staged.txt".to_string()]).unwrap();
    assert_eq!(stage.code, Some(0));
    assert_eq!(
        git(&root, &["diff", "--cached", "--name-only"]).stdout,
        b"staged.txt\n"
    );
    assert_eq!(fs::read(&tracked).unwrap(), b"original\n");

    // Clean only a genuinely untracked path; the staged entry stays in the index.
    fs::write(root.join("untracked.txt"), b"untracked\n").unwrap();
    let clean = local_with(
        &root,
        Recipe::CleanUntrackedPaths,
        &["untracked.txt".to_string()],
    )
    .unwrap();
    assert_eq!(clean.code, Some(0));
    assert!(!root.join("untracked.txt").exists());
    assert!(root.join("staged.txt").exists());
    fs::write(&tracked, b"discarded change\n").unwrap();
    let restore = local_with(
        &root,
        Recipe::RestoreTrackedPaths,
        &["tracked file.txt".to_string()],
    )
    .unwrap();
    assert_eq!(restore.code, Some(0));
    assert_eq!(fs::read(&tracked).unwrap(), b"original\n");
    assert_eq!(git(&root, &["rev-parse", "HEAD"]).stdout, head);

    // The NUL-delimited status recipe returns the same bytes as plain Git.
    let expected = git(&root, &["status", "--porcelain=2", "-z", "-uall"]);
    let actual = local(&root, Recipe::StatusPorcelainV2Nul).unwrap();
    assert_eq!(actual.code, expected.status.code());
    assert_eq!(actual.stdout.as_bytes(), expected.stdout);
    let expected_top = git(&root, &["rev-parse", "--show-toplevel"]);
    let actual_top = local(&root, Recipe::ShowToplevel).unwrap();
    assert_eq!(actual_top.stdout.as_bytes(), expected_top.stdout);

    // The bounded untracked count matches Git's own numstat and marks binaries.
    fs::write(root.join("counted.txt"), b"one\ntwo\nthree\n").unwrap();
    fs::write(root.join("binary.dat"), b"\x00\x01\x02").unwrap();
    let expected_count = git(
        &root,
        &[
            "diff",
            "--numstat",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "/dev/null",
            "--",
            "counted.txt",
        ],
    );
    let actual_count = local_with(
        &root,
        Recipe::UntrackedNumstat,
        &["counted.txt".to_string()],
    )
    .unwrap();
    assert_eq!(actual_count.code, expected_count.status.code());
    assert_eq!(actual_count.stdout.as_bytes(), expected_count.stdout);
    let binary = local_with(&root, Recipe::UntrackedNumstat, &["binary.dat".to_string()]).unwrap();
    assert!(binary.stdout.starts_with("-\t-"));
    assert_eq!(
        validate_paths(
            Recipe::UntrackedNumstat,
            &["a".to_string(), "b".to_string()]
        ),
        Err(ErrorCode::InvalidOperands)
    );
}
