//! Fixed workspace Git recipes: one closed action enum, fixed argv and limits.

use super::guard::{CHECK_INDEX, CHECK_REGULAR_PATHS, guard};
use super::history::{self, History};
use super::templates;
use super::{ErrorCode, quote, v1, workspace_command};
use std::time::Duration;
use v1::ProofWorkspaceGitAction as Action;

#[derive(Clone, Copy, Debug)]
pub(super) enum Recipe {
    Status,
    InsideWorkTree,
    StagedNumstat,
    UnstagedNumstat,
    OriginDefaultRef,
    OriginRemoteUrl,
    StatusPorcelainV2Nul,
    ShowToplevel,
    RestoreTrackedPaths,
    CleanUntrackedPaths,
    StagePaths,
    UntrackedNumstat,
    DiffStatus,
    HasHead,
    DiffAgainstHead,
    DiffStaged,
    DiffUnstaged,
    UntrackedFileDiff,
    LocalBranches,
    CommitLog,
    UpstreamRef,
    UnpushedShas,
    CommitSummary,
    CommitNumstat,
    CommitFileDiff,
    /// Actions 26-58: one fixed argv template each (`git.templates.rs`).
    Template(i32),
}

impl Recipe {
    pub(super) fn from_action(action: i32) -> Result<Self, ErrorCode> {
        if templates::template(action).is_some() {
            return Ok(Self::Template(action));
        }
        match Action::try_from(action) {
            Ok(Action::StatusPorcelainV2) => Ok(Self::Status),
            Ok(Action::IsInsideWorkTree) => Ok(Self::InsideWorkTree),
            Ok(Action::StagedNumstat) => Ok(Self::StagedNumstat),
            Ok(Action::UnstagedNumstat) => Ok(Self::UnstagedNumstat),
            Ok(Action::OriginDefaultRef) => Ok(Self::OriginDefaultRef),
            Ok(Action::OriginRemoteUrl) => Ok(Self::OriginRemoteUrl),
            Ok(Action::StatusPorcelainV2Nul) => Ok(Self::StatusPorcelainV2Nul),
            Ok(Action::ShowToplevel) => Ok(Self::ShowToplevel),
            Ok(Action::RestoreTrackedPaths) => Ok(Self::RestoreTrackedPaths),
            Ok(Action::CleanUntrackedPaths) => Ok(Self::CleanUntrackedPaths),
            Ok(Action::StagePaths) => Ok(Self::StagePaths),
            Ok(Action::UntrackedNumstat) => Ok(Self::UntrackedNumstat),
            Ok(Action::DiffStatus) => Ok(Self::DiffStatus),
            Ok(Action::HasHead) => Ok(Self::HasHead),
            Ok(Action::DiffAgainstHead) => Ok(Self::DiffAgainstHead),
            Ok(Action::DiffStaged) => Ok(Self::DiffStaged),
            Ok(Action::DiffUnstaged) => Ok(Self::DiffUnstaged),
            Ok(Action::UntrackedFileDiff) => Ok(Self::UntrackedFileDiff),
            Ok(Action::LocalBranches) => Ok(Self::LocalBranches),
            Ok(Action::CommitLog) => Ok(Self::CommitLog),
            Ok(Action::UpstreamRef) => Ok(Self::UpstreamRef),
            Ok(Action::UnpushedShas) => Ok(Self::UnpushedShas),
            Ok(Action::CommitSummary) => Ok(Self::CommitSummary),
            Ok(Action::CommitNumstat) => Ok(Self::CommitNumstat),
            Ok(Action::CommitFileDiff) => Ok(Self::CommitFileDiff),
            // Template actions (26-58) returned above.
            Ok(_) | Err(_) => Err(ErrorCode::InvalidOperands),
        }
    }

    pub(super) fn limits(self) -> (Duration, usize) {
        match self {
            Self::InsideWorkTree => (Duration::from_secs(5), 4096),
            // Commit hooks and worktree checkouts can take longer than a read.
            Self::Template(action) if templates::template(action).is_some_and(|t| t.mutation) => {
                (Duration::from_secs(120), 1_000_000)
            }
            _ => (Duration::from_secs(30), 1_000_000),
        }
    }

    /// Inclusive bounds on the number of repository-relative operands.
    pub(super) fn path_arity(self) -> (usize, usize) {
        match self {
            Self::RestoreTrackedPaths | Self::CleanUntrackedPaths | Self::StagePaths => (1, 200),
            Self::UntrackedNumstat | Self::UntrackedFileDiff => (1, 1),
            // A file and, for a rename or copy, its source path.
            Self::CommitFileDiff => (1, 2),
            Self::DiffStatus | Self::DiffAgainstHead | Self::DiffStaged | Self::DiffUnstaged => {
                (0, 1)
            }
            _ => (0, 0),
        }
    }

    /// Mutations can partially change the repository, so a lost/timeout result is ambiguous.
    pub(super) fn is_mutation(self) -> bool {
        if let Self::Template(action) = self {
            return templates::template(action).is_some_and(|t| t.mutation);
        }
        matches!(
            self,
            Self::RestoreTrackedPaths | Self::CleanUntrackedPaths | Self::StagePaths
        )
    }

    fn reads_named_file(self) -> bool {
        matches!(self, Self::UntrackedNumstat | Self::UntrackedFileDiff)
    }

    fn recipe(self) -> (&'static str, &'static str) {
        match self {
            Self::CommitLog
            | Self::UpstreamRef
            | Self::UnpushedShas
            | Self::CommitSummary
            | Self::CommitNumstat
            | Self::CommitFileDiff
            | Self::Template(_) => ("", ""),
            Self::Status => (CHECK_INDEX, "status --porcelain=2 --branch -uall"),
            Self::InsideWorkTree => ("", "rev-parse --is-inside-work-tree"),
            Self::StagedNumstat => (
                CHECK_INDEX,
                "diff --cached --numstat --no-ext-diff --no-textconv",
            ),
            Self::UnstagedNumstat => (CHECK_INDEX, "diff --numstat --no-ext-diff --no-textconv"),
            Self::OriginDefaultRef => ("", "symbolic-ref refs/remotes/origin/HEAD"),
            Self::OriginRemoteUrl => ("", "remote get-url origin"),
            Self::StatusPorcelainV2Nul => (CHECK_INDEX, "status --porcelain=2 -z -uall"),
            Self::ShowToplevel => ("", "rev-parse --show-toplevel"),
            Self::RestoreTrackedPaths => {
                (CHECK_INDEX, "restore --source=HEAD --staged --worktree --")
            }
            Self::CleanUntrackedPaths => ("", "clean -f -q --"),
            Self::StagePaths => (CHECK_INDEX, "add --"),
            Self::UntrackedNumstat => (
                "",
                "diff --numstat --no-index --no-ext-diff --no-textconv /dev/null --",
            ),
            Self::DiffStatus => (CHECK_INDEX, "status --porcelain=1 --untracked-files=all --"),
            Self::HasHead => ("", "rev-parse --verify HEAD"),
            Self::DiffAgainstHead => (
                CHECK_INDEX,
                "diff --find-renames --no-ext-diff --no-textconv HEAD --",
            ),
            Self::DiffStaged => (
                CHECK_INDEX,
                "diff --cached --find-renames --no-ext-diff --no-textconv --",
            ),
            Self::DiffUnstaged => (
                CHECK_INDEX,
                "diff --find-renames --no-ext-diff --no-textconv --",
            ),
            Self::UntrackedFileDiff => (
                "",
                "diff --no-index --no-ext-diff --no-textconv /dev/null --",
            ),
            Self::LocalBranches => ("", "branch --list --no-column '--format=%(refname:short)'"),
        }
    }

    pub(super) fn command(
        self,
        root: &str,
        paths: &[String],
        history: History<'_>,
        production: bool,
    ) -> String {
        if let Some(args) = history::args(self, history, paths) {
            let run = format!("clean_env \"$scope\" git {args}");
            let run = if matches!(self, Self::CommitFileDiff) {
                history::capped(&run, history.max_output_bytes)
            } else {
                run
            };
            return workspace_command(&format!("{}\n{run}", guard(production)), root, "");
        }
        let (preflight, args) = self.recipe();
        let operands = paths
            .iter()
            .map(|path| quote(path))
            .collect::<Vec<_>>()
            .join(" ");
        let named = if production && self.reads_named_file() {
            format!("set -- {operands}\n{CHECK_REGULAR_PATHS}")
        } else {
            String::new()
        };
        let suffix = if operands.is_empty() {
            String::new()
        } else {
            format!(" {operands}")
        };
        workspace_command(
            &format!(
                "{}{named}{preflight}\nclean_env \"$scope\" git {args}{suffix}",
                guard(production)
            ),
            root,
            "",
        )
    }

    /// A template recipe's full remote command: guard, index check, then the
    /// validated argv (capped and flagged, or as a commit with hooks).
    pub(super) fn template_command(
        template: &templates::Template,
        args: &str,
        root: &str,
        production: bool,
    ) -> String {
        let run = if template.commit {
            templates::commit_command(args)
        } else {
            format!("clean_env \"$scope\" git {args}")
        };
        let run = match template.cap {
            Some(cap) => history::capped(&run, cap),
            None => run,
        };
        workspace_command(
            &format!("{}{CHECK_INDEX}\n{run}", guard(production)),
            root,
            "",
        )
    }
}
