//! History panel recipes, run through the same remote shell recipe locally.

use super::super::tests::Fixture;
use super::tests::{git, init, setup};
use super::*;
use std::fs;
use std::path::Path;
use std::process::Command;

fn run(
    root: &Path,
    recipe: Recipe,
    paths: &[&str],
    history: History<'_>,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let paths = paths
        .iter()
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    validate_paths(recipe, &paths)?;
    history::validate(recipe, history)?;
    let remote = recipe.command(root.to_str().unwrap(), &paths, history, true);
    let mut cmd = Command::new("/bin/sh");
    cmd.args([
        "-c",
        &format!("export GIT_DIR=/dev/null GIT_WORK_TREE=/dev/null GIT_CONFIG_COUNT=99; {remote}"),
    ]);
    let (timeout, cap) = recipe.limits();
    let output = process::run_with_combined_output_limit(cmd, Instant::now() + timeout, 2 * cap)
        .map_err(|_| "local recipe failed")
        .unwrap();
    if matches!(recipe, Recipe::CommitFileDiff) {
        return decode_capped(output, cap, history.max_output_bytes as usize);
    }
    decode(output, cap)
}

fn repo(fixture: &Fixture) -> (std::path::PathBuf, String) {
    let root = fixture.0.clone();
    init(&root);
    setup(&root, &["config", "user.name", "Fixture"]);
    setup(&root, &["config", "user.email", "fixture@example.invalid"]);
    fs::write(root.join("old.txt"), "same\n".repeat(20)).unwrap();
    fs::write(root.join("small.txt"), "one\n").unwrap();
    setup(&root, &["add", "."]);
    setup(&root, &["commit", "-q", "-m", "base"]);
    setup(&root, &["mv", "old.txt", "renamed.txt"]);
    fs::write(root.join("big.txt"), "x".repeat(4000)).unwrap();
    fs::write(root.join("small.txt"), "two\n").unwrap();
    setup(&root, &["add", "."]);
    setup(&root, &["commit", "-q", "-m", "second"]);
    let sha = String::from_utf8(git(&root, &["rev-parse", "HEAD"]).stdout).unwrap();
    (root, sha.trim().to_string())
}

#[test]
fn log_summary_numstat_and_file_diff_match_local_git() {
    let fixture = Fixture::new();
    let (root, sha) = repo(&fixture);
    let log = run(
        &root,
        Recipe::CommitLog,
        &[],
        History {
            limit: 1,
            ..History::default()
        },
    )
    .unwrap();
    assert!(log.stdout.starts_with(&sha));
    assert_eq!(log.stdout.matches('\u{1e}').count(), 1);
    let summary = run(
        &root,
        Recipe::CommitSummary,
        &[],
        History {
            revision: &sha,
            ..History::default()
        },
    )
    .unwrap();
    assert!(summary.stdout.contains("\0second\0"));
    let numstat = run(
        &root,
        Recipe::CommitNumstat,
        &[],
        History {
            revision: &sha,
            ..History::default()
        },
    )
    .unwrap();
    assert!(numstat.stdout.contains("0\t0\t\0old.txt\0renamed.txt\0"));
    let small = run(
        &root,
        Recipe::CommitFileDiff,
        &["small.txt"],
        History {
            revision: &sha,
            max_output_bytes: 100_000,
            ..History::default()
        },
    )
    .unwrap();
    assert!(!small.stdout_truncated);
    assert!(small.stdout.contains("-one\n+two\n"));
    let renamed = run(
        &root,
        Recipe::CommitFileDiff,
        &["old.txt", "renamed.txt"],
        History {
            revision: &sha,
            max_output_bytes: 100_000,
            ..History::default()
        },
    )
    .unwrap();
    assert!(
        renamed
            .stdout
            .contains("rename from old.txt\nrename to renamed.txt\n")
    );
}

#[test]
fn an_oversized_file_diff_is_cut_and_flagged_not_failed() {
    let fixture = Fixture::new();
    let (root, sha) = repo(&fixture);
    let big = run(
        &root,
        Recipe::CommitFileDiff,
        &["big.txt"],
        History {
            revision: &sha,
            max_output_bytes: 1_000,
            ..History::default()
        },
    )
    .unwrap();
    assert!(big.stdout_truncated);
    assert_eq!(big.stdout.len(), 1_000);
}

#[test]
fn history_operands_are_validated_per_recipe() {
    let bad = |recipe, history| history::validate(recipe, history).is_err();
    assert!(bad(Recipe::CommitLog, History::default()));
    assert!(bad(
        Recipe::CommitLog,
        History {
            limit: 102,
            ..History::default()
        }
    ));
    for revision in ["HEAD", "--all", "abc", "ABCDEF12", "a..b"] {
        assert!(bad(
            Recipe::CommitSummary,
            History {
                revision,
                ..History::default()
            }
        ));
    }
    for revision in ["--all", "a..b", "x@{1}", "/abs", "origin/main.lock"] {
        assert!(bad(
            Recipe::UnpushedShas,
            History {
                revision,
                ..History::default()
            }
        ));
    }
    assert!(!bad(
        Recipe::UnpushedShas,
        History {
            revision: "origin/feature-1.2",
            ..History::default()
        }
    ));
    assert!(bad(
        Recipe::CommitFileDiff,
        History {
            revision: "abcd",
            ..History::default()
        }
    ));
    assert!(bad(
        Recipe::Status,
        History {
            revision: "abcd",
            ..History::default()
        }
    ));
    assert!(validate_paths(Recipe::CommitFileDiff, &[]).is_err());
}
