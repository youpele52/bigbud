//! Branch, checkout, commit, worktree and range templates, run locally through
//! the same production remote recipe.

use super::super::tests::Fixture;
use super::tests::{git, init, setup};
use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use v1::ProofWorkspaceGitAction as A;

fn run(
    root: &Path,
    home: &Path,
    action: A,
    operands: &[&str],
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let action = action as i32;
    let template = templates::template(action).expect("template action");
    let operands = operands.iter().map(|o| o.to_string()).collect::<Vec<_>>();
    let root_str = root.to_str().unwrap();
    let args = templates::args(template, &operands, root_str)?;
    let remote = Recipe::template_command(template, &args, root_str, true);
    if std::env::var("BB_DEBUG").is_ok() {
        eprintln!("REMOTE<<{remote}>>");
    }
    let mut cmd = Command::new("/bin/sh");
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .args([
            "-c",
            // The bounded runner clears the environment; an SSH session has HOME.
            &format!(
                "export HOME={} GIT_DIR=/dev/null GIT_CONFIG_COUNT=99; {remote}",
                home.display()
            ),
        ]);
    let recipe = Recipe::from_action(action)?;
    let (timeout, cap) = recipe.limits();
    let output = process::run_with_combined_output_limit(cmd, Instant::now() + timeout, 2 * cap)
        .map_err(|_| "local recipe failed")
        .unwrap();
    match template.cap {
        Some(limit) => decode_capped(output, cap, limit as usize),
        None => decode(output, cap),
    }
}

fn repo(fixture: &Fixture) -> std::path::PathBuf {
    // The workspace root is a child so worktrees can be its siblings.
    let root = fixture.0.join("project");
    fs::create_dir(&root).unwrap();
    init(&root);
    fs::write(root.join("a.txt"), "one\n").unwrap();
    setup(&root, &["add", "a.txt"]);
    setup(
        &root,
        &[
            "-c",
            "user.name=Seed",
            "-c",
            "user.email=seed@example.invalid",
            "commit",
            "-q",
            "-m",
            "base",
        ],
    );
    root
}

/// Commits need an identity. Linux runners have no GECOS name, so give the fixture HOME one.
fn home_with_identity(fixture: &Fixture) -> std::path::PathBuf {
    let home = fixture.0.clone();
    fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = Fixture User\n\temail = fixture@example.invalid\n",
    )
    .unwrap();
    home
}

fn stdout(result: Result<ProofWorkspaceGitResult, ErrorCode>) -> String {
    let result = result.unwrap();
    assert_eq!(result.code, Some(0), "{result:?}");
    result.stdout
}

#[test]
fn every_template_action_is_declared_in_order() {
    for action in templates::FIRST..templates::FIRST + templates::TEMPLATES.len() as i32 {
        assert!(A::try_from(action).is_ok(), "{action}");
        assert!(matches!(
            Recipe::from_action(action),
            Ok(Recipe::Template(_))
        ));
    }
    assert!(Recipe::from_action(75).is_err());
    assert!(Recipe::from_action(A::Commit as i32).unwrap().is_mutation());
    assert!(
        !Recipe::from_action(A::RangeLog as i32)
            .unwrap()
            .is_mutation()
    );
}

#[test]
fn commit_uses_global_identity_and_runs_repository_hooks() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    let home = fixture.0.join("home");
    fs::create_dir(&home).unwrap();
    fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = Global User\n\temail = g@example.invalid\n",
    )
    .unwrap();
    fs::create_dir(root.join(".hooks")).unwrap();
    let hook = root.join(".hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho hook-ran > \"$HOME/hook.log\"\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    setup(&root, &["config", "core.hooksPath", ".hooks"]);
    fs::write(root.join("b.txt"), "two\n").unwrap();
    stdout(run(&root, &home, A::AddSelected, &["b.txt"]));
    assert_eq!(
        stdout(run(&root, &home, A::StagedSummary, &[])),
        "A\tb.txt\n"
    );
    stdout(run(
        &root,
        &home,
        A::CommitWithBody,
        &["feat: subject", "-body that looks like an option"],
    ));
    let log =
        String::from_utf8(git(&root, &["log", "-1", "--format=%an <%ae>%n%s%n%b"]).stdout).unwrap();
    assert!(log.starts_with("Global User <g@example.invalid>\nfeat: subject\n-body"));
    assert_eq!(
        fs::read_to_string(home.join("hook.log")).unwrap(),
        "hook-ran\n"
    );
}

#[test]
fn an_escaping_hooks_path_is_refused() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    for value in ["/tmp/hooks", "../hooks", "~/hooks"] {
        setup(&root, &["config", "core.hooksPath", value]);
        assert!(matches!(
            run(&root, &fixture.0, A::Commit, &["x"]),
            Err(ErrorCode::WorkspaceReadFailed)
        ));
    }
}

#[test]
fn branches_checkout_and_worktrees() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    let home = fixture.0.clone();
    stdout(run(&root, &home, A::BranchCreate, &["feature/x"]));
    assert_eq!(
        run(&root, &home, A::ShowRefHead, &["refs/heads/feature/x"])
            .unwrap()
            .code,
        Some(0)
    );
    stdout(run(&root, &home, A::Checkout, &["feature/x"]));
    assert_eq!(
        stdout(run(&root, &home, A::CurrentBranch, &[])),
        "feature/x\n"
    );
    stdout(run(&root, &home, A::BranchRenameCurrent, &["feature/y"]));
    stdout(run(&root, &home, A::Checkout, &["proof"]));
    stdout(run(&root, &home, A::BranchDelete, &["feature/y"]));
    let sibling = fixture.0.join("project-wt");
    let sibling = sibling.to_str().unwrap();
    stdout(run(
        &root,
        &home,
        A::WorktreeAddNewBranch,
        &["wt-branch", sibling, "proof"],
    ));
    assert!(
        stdout(run(&root, &home, A::WorktreeList, &[])).contains(&format!("worktree {sibling}\n"))
    );
    stdout(run(&root, &home, A::WorktreeRemove, &[sibling]));
    assert!(!Path::new(sibling).exists());
    assert!(stdout(run(&root, &home, A::LocalBranchList, &[])).contains("wt-branch"));
}

#[test]
fn range_reads_are_capped_and_flagged() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    setup(&root, &["branch", "base"]);
    fs::write(root.join("a.txt"), "x".repeat(80_000)).unwrap();
    setup(
        &root,
        &[
            "-c",
            "user.name=S",
            "-c",
            "user.email=s@x",
            "commit",
            "-q",
            "-am",
            "big",
        ],
    );
    let patch = run(&root, &fixture.0, A::RangeDiffPatch, &["base..HEAD"]).unwrap();
    assert!(patch.stdout_truncated);
    assert_eq!(patch.stdout.len(), 59_000);
    let log = run(&root, &fixture.0, A::RangeLog, &["base..HEAD"]).unwrap();
    assert!(!log.stdout_truncated);
    assert!(log.stdout.ends_with(" big\n"));
}

#[test]
fn operands_are_typed_per_slot() {
    let root = "/home/u/project";
    let bad = |action: A, operands: &[&str]| {
        let operands = operands.iter().map(|o| o.to_string()).collect::<Vec<_>>();
        templates::args(templates::template(action as i32).unwrap(), &operands, root).is_err()
    };
    assert!(bad(A::Checkout, &["--orphan"]));
    assert!(bad(A::Checkout, &["a..b"]));
    assert!(bad(A::Checkout, &[]));
    assert!(bad(A::Checkout, &["main", "extra"]));
    assert!(bad(A::ShowRefHead, &["refs/tags/v1"]));
    assert!(bad(A::RangeLog, &["--all..HEAD"]));
    assert!(bad(A::AddSelected, &["../outside"]));
    assert!(bad(A::Commit, &["   "]));
    assert!(bad(A::WorktreeAdd, &["/etc/wt", "main"]));
    assert!(bad(A::WorktreeAdd, &["/home/u/project/inner", "main"]));
    assert!(bad(A::WorktreeAdd, &["/home/u/../wt", "main"]));
    assert!(bad(A::WorktreeRemove, &[root]));
    assert!(!bad(A::WorktreeAdd, &["/home/u/project-wt", "main"]));
    assert!(!bad(A::SetUpstream, &["origin/main", "main"]));
}

#[test]
fn stash_new_branches_force_delete_init_and_remote_add() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    let home = home_with_identity(&fixture);
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    stdout(run(&root, &home, A::StashPushMessage, &["wip"]));
    assert!(stdout(run(&root, &home, A::StashList, &[])).contains("wip"));
    stdout(run(&root, &home, A::StashApplyRef, &["stash@{0}"]));
    stdout(run(&root, &home, A::StashDrop, &[]));
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "changed\n");
    stdout(run(
        &root,
        &home,
        A::CheckoutNewBranchFrom,
        &["topic", "proof"],
    ));
    fs::write(root.join("t.txt"), "t\n").unwrap();
    stdout(run(&root, &home, A::AddAll, &[]));
    stdout(run(&root, &home, A::Commit, &["topic work"]));
    stdout(run(&root, &home, A::Checkout, &["proof"]));
    // Unmerged: `-d` refuses, `-D` deletes exactly the named branch.
    assert_ne!(
        run(&root, &home, A::BranchDelete, &["topic"]).unwrap().code,
        Some(0)
    );
    stdout(run(&root, &home, A::BranchForceDelete, &["topic"]));
    stdout(run(
        &root,
        &home,
        A::RemoteAdd,
        &["upstream", "git@example.invalid:o/r.git"],
    ));
    assert!(
        stdout(run(&root, &home, A::RemoteUrls, &[]))
            .contains("upstream\tgit@example.invalid:o/r.git")
    );
    let empty = fixture.0.join("fresh");
    fs::create_dir(&empty).unwrap();
    stdout(run(&empty, &home, A::Init, &[]));
    assert!(empty.join(".git/HEAD").is_file());
}

#[test]
fn commands_run_inside_a_linked_worktree() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    let home = home_with_identity(&fixture);
    let linked = fixture.0.join("project-linked");
    let linked_str = linked.to_str().unwrap();
    stdout(run(
        &root,
        &home,
        A::WorktreeAddNewBranch,
        &["linked", linked_str, "proof"],
    ));
    assert_eq!(
        stdout(run(&linked, &home, A::CurrentBranch, &[])),
        "linked\n"
    );
    fs::write(linked.join("w.txt"), "w\n").unwrap();
    stdout(run(&linked, &home, A::AddSelected, &["w.txt"]));
    stdout(run(&linked, &home, A::Commit, &["in linked worktree"]));
    let log =
        String::from_utf8(git(&root, &["log", "-1", "--format=%s", "linked"]).stdout).unwrap();
    assert_eq!(log, "in linked worktree\n");
}

#[test]
fn other_gitdir_redirections_are_refused() {
    let fixture = Fixture::new();
    let root = repo(&fixture);
    let home = fixture.0.clone();
    let linked = fixture.0.join("project-linked");
    stdout(run(
        &root,
        &home,
        A::WorktreeAddNewBranch,
        &["linked", linked.to_str().unwrap(), "proof"],
    ));
    let original = fs::read_to_string(linked.join(".git")).unwrap();
    for redirect in [
        format!("gitdir: {}\n", root.join(".git").display()),
        format!(
            "gitdir: {}/../project/.git/worktrees/project-linked\n",
            fixture.0.display()
        ),
        "gitdir: relative/.git/worktrees/x\n".to_string(),
        format!("{original}extra line\n"),
    ] {
        fs::write(linked.join(".git"), &redirect).unwrap();
        assert!(
            matches!(
                run(&linked, &home, A::CurrentBranch, &[]),
                Err(ErrorCode::WorkspaceReadFailed)
            ),
            "{redirect}"
        );
    }
    fs::write(linked.join(".git"), &original).unwrap();
    fs::write(
        root.join(".git/worktrees/project-linked/commondir"),
        "/elsewhere\n",
    )
    .unwrap();
    assert!(matches!(
        run(&linked, &home, A::CurrentBranch, &[]),
        Err(ErrorCode::WorkspaceReadFailed)
    ));
}

#[test]
fn new_slot_types_are_validated() {
    let root = "/home/u/project";
    let bad = |action: A, operands: &[&str]| {
        let operands = operands.iter().map(|o| o.to_string()).collect::<Vec<_>>();
        templates::args(templates::template(action as i32).unwrap(), &operands, root).is_err()
    };
    assert!(bad(A::StashPopRef, &["stash@{x}"]));
    assert!(bad(A::StashPopRef, &["HEAD"]));
    assert!(bad(A::RemoteAdd, &["up/stream", "https://x"]));
    assert!(bad(A::RemoteAdd, &["up", "ext::sh -c x"]));
    assert!(bad(A::RemoteAdd, &["up", "--upload-pack=x"]));
    assert!(bad(A::CheckoutNewBranchFrom, &["b", "--orphan"]));
    assert!(bad(A::WorktreeAddNewBranchAt, &["b", "/home/u/wt", "main"]));
    assert!(!bad(
        A::WorktreeAddNewBranchAt,
        &["b", "/home/u/wt", "abcdef12"]
    ));
    assert!(!bad(A::RemoteAdd, &["up", "/srv/repo.git"]));
}
