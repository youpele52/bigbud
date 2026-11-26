//! C06 (B): production workspace Git recipes and guard, run through the same
//! remote shell recipe locally (no OpenSSH, no ambient Git settings).

use super::super::tests::Fixture;
use super::tests::{git, init, setup};
use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Command;

fn run(
    root: &Path,
    recipe: Recipe,
    paths: &[&str],
    production: bool,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let paths = paths
        .iter()
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    validate_paths(recipe, &paths)?;
    let remote = recipe.command(
        root.to_str().unwrap(),
        &paths,
        History::default(),
        production,
    );
    let mut cmd = Command::new("/bin/sh");
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

/// A repository shaped like a real clone: tracking config, hooksPath and a
/// symlink in the worktree.
fn real_clone(fixture: &Fixture) -> std::path::PathBuf {
    let root = fixture.0.clone();
    init(&root);
    setup(&root, &["config", "user.name", "Fixture"]);
    setup(&root, &["config", "user.email", "fixture@example.invalid"]);
    setup(
        &root,
        &["remote", "add", "origin", "ssh://example.invalid/repo.git"],
    );
    setup(&root, &["config", "branch.proof.remote", "origin"]);
    setup(&root, &["config", "branch.proof.merge", "refs/heads/proof"]);
    setup(&root, &["config", "core.hooksPath", ".husky"]);
    fs::write(root.join("tracked.txt"), "one\n").unwrap();
    symlink("tracked.txt", root.join("link")).unwrap();
    setup(&root, &["add", "tracked.txt", "link"]);
    setup(&root, &["commit", "-q", "-m", "initial"]);
    root
}

#[test]
fn production_guard_admits_a_real_clone_the_fixture_guard_refuses() {
    let fixture = Fixture::new();
    let root = real_clone(&fixture);
    assert!(matches!(
        run(&root, Recipe::Status, &[], false),
        Err(ErrorCode::WorkspaceReadFailed)
    ));
    let status = run(&root, Recipe::Status, &[], true).unwrap();
    assert_eq!(status.code, Some(0));
    assert!(status.stdout.contains("# branch.head proof"));
    assert!(status.stdout.contains("# branch.upstream origin/proof"));
}

#[test]
fn production_guard_still_refuses_helper_config_and_submodules() {
    for (key, value) in [
        ("core.fsmonitor", "true"),
        ("filter.x.clean", "cat"),
        ("diff.x.textconv", "cat"),
        ("include.path", "/dev/null"),
        ("core.sshCommand", "ssh"),
    ] {
        let fixture = Fixture::new();
        let root = real_clone(&fixture);
        setup(&root, &["config", key, value]);
        assert!(
            matches!(
                run(&root, Recipe::Status, &[], true),
                Err(ErrorCode::WorkspaceReadFailed)
            ),
            "{key}"
        );
    }
    let fixture = Fixture::new();
    let root = real_clone(&fixture);
    fs::write(root.join(".gitmodules"), "").unwrap();
    assert!(matches!(
        run(&root, Recipe::DiffUnstaged, &[], true),
        Err(ErrorCode::WorkspaceReadFailed)
    ));
}

#[test]
fn diff_and_branch_recipes_match_local_git() {
    let fixture = Fixture::new();
    let root = real_clone(&fixture);
    fs::write(root.join("tracked.txt"), "two\n").unwrap();
    fs::write(root.join("new.txt"), "fresh\n").unwrap();
    setup(&root, &["branch", "side"]);

    let head = run(&root, Recipe::HasHead, &[], true).unwrap();
    assert_eq!(head.code, Some(0));
    let unstaged = run(&root, Recipe::DiffUnstaged, &["tracked.txt"], true).unwrap();
    assert!(unstaged.stdout.contains("-one\n+two\n"));
    let against_head = run(&root, Recipe::DiffAgainstHead, &[], true).unwrap();
    assert_eq!(
        against_head.stdout.as_bytes(),
        git(&root, &["diff", "--find-renames", "HEAD", "--"]).stdout
    );
    let staged = run(&root, Recipe::DiffStaged, &[], true).unwrap();
    assert_eq!((staged.code, staged.stdout.as_str()), (Some(0), ""));
    let status = run(&root, Recipe::DiffStatus, &[], true).unwrap();
    assert!(status.stdout.contains("?? new.txt\n"));
    let untracked = run(&root, Recipe::UntrackedFileDiff, &["new.txt"], true).unwrap();
    assert_eq!(untracked.code, Some(1));
    assert!(untracked.stdout.contains("+fresh\n"));
    let branches = run(&root, Recipe::LocalBranches, &[], true).unwrap();
    assert_eq!(branches.stdout, "proof\nside\n");
}

#[test]
fn has_head_is_an_ordinary_exit_on_an_unborn_branch() {
    let fixture = Fixture::new();
    let root = fixture.0.clone();
    init(&root);
    let head = run(&root, Recipe::HasHead, &[], true).unwrap();
    assert_eq!(head.code, Some(128));
}

#[test]
fn named_file_reads_refuse_links_and_non_files_in_production() {
    let fixture = Fixture::new();
    let root = real_clone(&fixture);
    let outside = Fixture::new();
    fs::write(outside.0.join("secret.txt"), "secret\n").unwrap();
    symlink(&outside.0, root.join("escape")).unwrap();
    for path in ["escape/secret.txt", "link", "missing.txt"] {
        for recipe in [Recipe::UntrackedFileDiff, Recipe::UntrackedNumstat] {
            assert!(
                matches!(
                    run(&root, recipe, &[path], true),
                    Err(ErrorCode::WorkspacePathDenied)
                ),
                "{path}"
            );
        }
    }
}

#[test]
fn diff_recipes_take_at_most_one_safe_path() {
    for recipe in [
        Recipe::DiffStatus,
        Recipe::DiffAgainstHead,
        Recipe::DiffStaged,
        Recipe::DiffUnstaged,
    ] {
        assert!(validate_paths(recipe, &[]).is_ok());
        assert!(validate_paths(recipe, &["a".into()]).is_ok());
        assert!(validate_paths(recipe, &["a".into(), "b".into()]).is_err());
        assert!(validate_paths(recipe, &["--output=/tmp/x".into()]).is_err());
        assert!(validate_paths(recipe, &["../x".into()]).is_err());
    }
    assert!(validate_paths(Recipe::UntrackedFileDiff, &[]).is_err());
    for recipe in [Recipe::HasHead, Recipe::LocalBranches] {
        assert!(validate_paths(recipe, &["a".into()]).is_err());
    }
    for action in 13..=25 {
        assert!(Recipe::from_action(action).is_ok());
        assert!(!Recipe::from_action(action).unwrap().is_mutation());
    }
    assert!(Recipe::from_action(75).is_err());
}
