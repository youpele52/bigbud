use super::{
    ErrorCode, Transport, process, quote, ssh_failure, v1, validate_path, workspace_command,
};
use std::time::{Duration, Instant};
use v1::{
    ProofWorkspaceGit, ProofWorkspaceGitAction as Action, ProofWorkspaceGitOutcome as Outcome,
    ProofWorkspaceGitResult,
};

// Unlike index.rs, status needs the real refs, objects and local config for
// branch and change records. Only accept an ordinary, self-contained fixture;
// don't substitute scratch metadata or silently override unsupported settings.
// As with the sibling workspace recipes, this is not a defense against
// concurrent remote path/metadata replacement.
const GUARD: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
command -v git >/dev/null 2>&1 || exit 4
clean_env() {
  exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME=/dev/null XDG_CONFIG_HOME=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 "$@"
}
if [ ! -L .git ] && [ ! -e .git ]; then
  # Don't discover a bare repo at the root or any repo above it. By keeping
  # discovery (rather than inventing a .git directory), Git can report its
  # own ordinary not-a-repository exit and output.
  [ ! -L HEAD ] && [ ! -e HEAD ] || exit 4
  parent=${PWD%/*}
  case "$parent" in *:*) exit 4 ;; esac
  scope=GIT_CEILING_DIRECTORIES=:${parent:-/}
else
  [ ! -L .git ] && [ -d .git ] || exit 4
  # Check the metadata and the worktree with a physical walk. Nested Git
  # metadata, links, and special files are outside this fixture's contract.
  unsafe=$(find . \( \( ! -type d ! -type f \) -o \( ! -path './.git' -name '.[gG][iI][tT]' \) \
    -o -name '.[gG][iI][tT][mM][oO][dD][uU][lL][eE][sS]' \) -print -quit) || exit 4
  [ -z "$unsafe" ] || exit 4
  [ -f .git/HEAD ] && [ -d .git/objects ] && [ -d .git/refs ] || exit 4
  for path in .git/commondir .git/gitdir .git/modules .git/objects/info/alternates .git/objects/info/http-alternates; do
    [ ! -e "$path" ] || exit 4
  done
  # Parse only the local file, without discovery or includes. The sentinel
  # proves that the producer succeeded even on a shell without pipefail.
  # Map embedded LF to an invalid key character before splitting NUL records.
  if [ -e .git/config ]; then
    { (clean_env GIT_DIR=/dev/null git config --file .git/config --no-includes --null --name-only --list) 2>/dev/null &&
        printf 'OK\000'; } | tr '\n\000' '?\n' | awk '
      /^OK$/ { complete = 1; next }
      /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|quotepath)$/ { next }
      /^user\.(name|email)$/ { next }
      /^remote\.origin\.url$/ { next }
      { bad = 1 }
      END { if (!complete || bad) exit 1 }
    ' || exit 4
  fi
  scope=GIT_DIR=.git
fi
"#;

// Reject gitlinks (status may launch a subprocess in one), sparse tree
// entries and non-local paths before Git stats anything from the index.
// Git C-quotes LF/tab and other unusual bytes but leaves '/' and '.' literal.
const CHECK_INDEX: &str = r#"
if [ "$scope" = GIT_DIR=.git ]; then
  { (clean_env "$scope" git -c core.quotePath=true ls-files --stage) 2>/dev/null && printf 'OK\n'; } |
    awk -F '\t' '
      /^OK$/ { complete = 1; next }
      NF != 2 || $1 !~ /^(100644|100755|120000) [0-9a-f]+ [0-3]$/ { bad = 1; next }
      {
        path = $2
        if (path ~ /^"/) path = substr(path, 2, length(path) - 2)
        if (path ~ /(^|\/)(\.{1,2})?(\/|$)/) bad = 1
      }
      END { if (!complete || bad) exit 1 }
    ' || exit 4
fi
"#;

#[derive(Clone, Copy, Debug)]
enum Recipe {
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
}

impl Recipe {
    fn from_action(action: i32) -> Result<Self, ErrorCode> {
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
            Ok(Action::Unspecified) | Err(_) => Err(ErrorCode::InvalidOperands),
        }
    }

    fn limits(self) -> (Duration, usize) {
        match self {
            Self::InsideWorkTree => (Duration::from_secs(5), 4096),
            _ => (Duration::from_secs(30), 1_000_000),
        }
    }

    fn needs_paths(self) -> bool {
        matches!(
            self,
            Self::RestoreTrackedPaths
                | Self::CleanUntrackedPaths
                | Self::StagePaths
                | Self::UntrackedNumstat
        )
    }

    /// Mutations can partially change the repository, so a lost/timeout result is ambiguous.
    fn is_mutation(self) -> bool {
        matches!(
            self,
            Self::RestoreTrackedPaths | Self::CleanUntrackedPaths | Self::StagePaths
        )
    }

    fn command(self, root: &str, paths: &[String]) -> String {
        let (preflight, args) = match self {
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
        };
        let operands = if paths.is_empty() {
            String::new()
        } else {
            format!(
                " {}",
                paths
                    .iter()
                    .map(|path| quote(path))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        workspace_command(
            &format!("{GUARD}{preflight}\nclean_env \"$scope\" git {args}{operands}"),
            root,
            "",
        )
    }
}

const MAX_MUTATION_PATHS: usize = 200;
const MAX_MUTATION_PATH_BYTES: usize = 4096;

/// Path operands are repository-relative data, never options or absolute paths.
fn validate_paths(recipe: Recipe, paths: &[String]) -> Result<(), ErrorCode> {
    if recipe.needs_paths() == paths.is_empty() {
        return Err(ErrorCode::InvalidOperands);
    }
    if paths.len() > MAX_MUTATION_PATHS {
        return Err(ErrorCode::InvalidOperands);
    }
    if matches!(recipe, Recipe::UntrackedNumstat) && paths.len() != 1 {
        return Err(ErrorCode::InvalidOperands);
    }
    for path in paths {
        if path.is_empty()
            || path.len() > MAX_MUTATION_PATH_BYTES
            || path.contains('\0')
            || path.contains('\\')
            || path.starts_with('/')
            || path.starts_with('-')
            || !path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
        {
            return Err(ErrorCode::InvalidOperands);
        }
    }
    Ok(())
}

pub(in super::super) fn execute(
    transport: &Transport,
    operand: &ProofWorkspaceGit,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let recipe = Recipe::from_action(operand.action)?;
    validate_paths(recipe, &operand.paths)?;
    let root = validate_path(
        transport.config.workspace_root.as_deref(),
        &operand.workspace_root,
        "",
        true,
    )?;
    let (timeout, stream_limit) = recipe.limits();
    let deadline = Instant::now() + timeout;
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned
        .command
        .args(["--", &transport.host, &recipe.command(root, &operand.paths)]);
    let output =
        match process::run_with_combined_output_limit(pinned.command, deadline, 2 * stream_limit) {
            Ok(output) => output,
            // A mutation that lost its bounded reply may already have changed the repository.
            Err(process::Failure::TimedOut | process::Failure::Io) if recipe.is_mutation() => {
                return Ok(ambiguous());
            }
            Err(process::Failure::TimedOut) => return Err(ErrorCode::WorkspaceReadFailed),
            Err(process::Failure::Spawn) => return Err(ErrorCode::OwnerUnavailable),
            Err(process::Failure::Io) => return Err(ErrorCode::TransportLost),
        };
    decode(output, stream_limit)
}

fn ambiguous() -> ProofWorkspaceGitResult {
    ProofWorkspaceGitResult {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        outcome: Outcome::OutcomeUnknown as i32,
    }
}

fn decode(
    output: process::Output,
    stream_limit: usize,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let code = match output.status.code() {
        // Reserved shell guard/exec failures are not Git exits. The selected
        // builtins use zero or Git's fatal/usage exit codes.
        Some(3) => return Err(ErrorCode::WorkspacePathDenied),
        Some(4 | 126 | 127) => return Err(ErrorCode::WorkspaceReadFailed),
        Some(255) => return Err(ssh_failure(&output.stderr)),
        None => return Err(ErrorCode::TransportLost),
        Some(code) => code,
    };
    if output.truncated || output.stdout.len() > stream_limit || output.stderr.len() > stream_limit
    {
        return Err(ErrorCode::WorkspaceReadFailed);
    }
    Ok(ProofWorkspaceGitResult {
        code: Some(code),
        stdout: decode_text(&output.stdout),
        stderr: decode_text(&output.stderr),
        outcome: Outcome::Unspecified as i32,
    })
}

fn decode_text(bytes: &[u8]) -> String {
    // Match the app's UTF-8 TextDecoder (replacement for invalid bytes, with
    // an initial BOM consumed). Limits are on bytes before decoding.
    let bytes = match bytes.strip_prefix(b"\xef\xbb\xbf") {
        Some(text) => text,
        None => bytes,
    };
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
#[path = "git.tests.rs"]
mod tests;

#[cfg(test)]
#[path = "git.mutation.tests.rs"]
mod mutation_tests;
