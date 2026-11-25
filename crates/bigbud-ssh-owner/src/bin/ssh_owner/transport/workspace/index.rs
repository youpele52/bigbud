use super::{
    ErrorCode, Transport, normal_components, process, ssh_failure, v1, validate_path,
    workspace_command,
};
use prost::{Message, length_delimiter_len};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use v1::{ProofWorkspaceIndex, ProofWorkspaceIndexResult, ProofWorkspaceIndexedEntry};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ENTRIES: usize = 25_000;
const WIRE_LIMIT: usize = 8 * 1024 * 1024;
// Reserve space for the enclosing frame and reply (128-byte request ID, two
// 32-byte tokens and protobuf framing), including the result's truncated flag.
const ENTRIES_WIRE_LIMIT: usize = WIRE_LIMIT - 256;
const GIT_MARKER: &[u8] = b"BIGBUD_WORKSPACE_INDEX_GIT_V1\0";
const FIND_MARKER: &[u8] = b"BIGBUD_WORKSPACE_INDEX_FIND_V1\0";
const ENTER: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
"#;

// Use only in-root, ordinary Git metadata. A private scratch Git directory
// isolates local config/includes, refs, objects, hooks and linked worktrees;
// the only original metadata supplied to Git is the index and info/exclude.
// Like the other workspace recipes, these static checks are not race-proof.
const GIT: &str = r#"
git_index() (
  [ ! -L .git ] && [ -d .git ] && [ ! -L .git/HEAD ] && [ -f .git/HEAD ] || exit 1
  [ ! -L .git/commondir ] && [ ! -e .git/commondir ] || exit 1
  [ ! -L .git/objects ] && [ -d .git/objects ] && [ ! -L .git/refs ] && [ -d .git/refs ] || exit 1
  [ ! -L .git/index ] && { [ ! -e .git/index ] || [ -f .git/index ]; } || exit 1
  [ ! -L .git/info ] && { [ ! -e .git/info ] || [ -d .git/info ]; } || exit 1
  [ ! -L .git/info/exclude ] || exit 1
  exclude=/dev/null
  if [ -e .git/info/exclude ]; then
    [ -f .git/info/exclude ] || exit 1
    exclude=$PWD/.git/info/exclude
  fi
  command -v git >/dev/null 2>&1 || exit 1
  # Git probes nested .git entries while enumerating untracked names, and a
  # gitfile there can point anywhere. Use physical find to detect those cases
  # before letting Git inspect the worktree. Also reject linked ignore files.
  unsafe=$(find . -path './.git' -prune -o \( -name '.[gG][iI][tT]' \
    -o \( -name '.[gG][iI][tT][iI][gG][nN][oO][rR][eE]' -type l \) \) -print -quit) || exit 1
  [ -z "$unsafe" ] || exit 1
  umask 077
  scratch=$(mktemp -d /tmp/bigbud-workspace-index.XXXXXXXXXX) || exit 1
  trap 'rm -rf "$scratch"' 0
  trap 'exit 2' HUP INT TERM
  mkdir "$scratch/objects" "$scratch/refs" &&
    printf '%s\n' 'ref: refs/heads/index' > "$scratch/HEAD" || exit 1
  printf 'BIGBUD_WORKSPACE_INDEX_GIT_V1\000' || exit 2
  env -i PATH=/usr/bin:/bin LC_ALL=C GIT_INDEX_FILE="$PWD/.git/index" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 \
    git --git-dir="$scratch" --work-tree=. -c core.fsmonitor=false \
      -c core.hooksPath=/dev/null -c core.excludesFile="$exclude" \
      ls-files --cached --others --exclude-standard -z || exit 2
)
"#;

// The default find walk is physical (no -L or -H). POSIX batched -exec and
// printf keep NUL records portable across BSD and GNU find, without a shell
// interpreting filenames. Keep this prune list aligned with the legacy scan.
const FIND: &str = r#"
printf 'BIGBUD_WORKSPACE_INDEX_FIND_V1\000' || exit 1
exec find . \( -name '.[gG][iI][tT]' -o -name .convex -o -name node_modules -o -name .next \
  -o -name .turbo -o -name dist -o -name build -o -name out -o -name .cache \) -prune -o \
  \( ! -name . -type d -exec /usr/bin/printf 'd\t%s\000' {} + \) -o \
  \( -type f -exec /usr/bin/printf 'f\t%s\000' {} + \)
"#;

const TRY_GIT: &str = r#"
git_index 2>/dev/null
case $? in
  0) exit 0 ;;
  1) ;; # No eligible repository or Git executable; no Git records were emitted.
  *) exit 5 ;; # Do not mix a failed Git stream with a fallback stream.
esac
"#;

fn command(root: &str, try_git: bool) -> String {
    let script = if try_git {
        format!("{ENTER}{GIT}{TRY_GIT}{FIND}")
    } else {
        format!("{ENTER}{FIND}")
    };
    workspace_command(&script, root, "")
}

pub(in super::super) fn index(
    transport: &Transport,
    operand: &ProofWorkspaceIndex,
) -> Result<ProofWorkspaceIndexResult, ErrorCode> {
    let deadline = Instant::now() + TIMEOUT;
    let root = validate_path(
        transport.config.workspace_root.as_deref(),
        &operand.workspace_root,
        "",
        true,
    )?;
    let scan = |try_git| {
        if Instant::now() >= deadline {
            return Err(ErrorCode::WorkspaceReadFailed);
        }
        // Use the same pinned transport and runner as workspace reads, but
        // pass one absolute deadline so fallback cannot reset the clock.
        transport.revalidate_policy()?;
        let mut pinned = transport.pinned_ssh("-T")?;
        pinned
            .command
            .args(["--", &transport.host, &command(root, try_git)]);
        process::run(pinned.command, deadline, WIRE_LIMIT).map_err(|error| match error {
            process::Failure::TimedOut => ErrorCode::WorkspaceReadFailed,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io => ErrorCode::TransportLost,
        })
    };
    let mut output = scan(true)?;
    if output.status.code() == Some(5) {
        output = scan(false)?;
    }
    let result = match output.status.code() {
        Some(0) => parse(&output.stdout, output.truncated, ENTRIES_WIRE_LIMIT),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }?;
    if Instant::now() >= deadline {
        return Err(ErrorCode::WorkspaceReadFailed);
    }
    Ok(result)
}

fn parse(
    bytes: &[u8],
    capture_truncated: bool,
    entries_wire_limit: usize,
) -> Result<ProofWorkspaceIndexResult, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let (git, payload) = if let Some(payload) = bytes.strip_prefix(GIT_MARKER) {
        (true, payload)
    } else {
        (false, bytes.strip_prefix(FIND_MARKER).ok_or(failed)?)
    };
    let mut entries = Entries {
        paths: BTreeMap::new(),
        bytes_left: entries_wire_limit,
    };
    let mut truncated = capture_truncated;
    for raw in payload.split_inclusive(|&byte| byte == 0) {
        let Some(record) = raw.strip_suffix(b"\0") else {
            if capture_truncated {
                break;
            }
            return Err(failed);
        };
        let (directory, path) = if git {
            // Cached names are data, even if deleted or now occupied by a
            // symlink. Do not try to stat or open any name from the index.
            (false, record)
        } else {
            match record {
                [b'd', b'\t', b'.', b'/', path @ ..] => (true, path),
                [b'f', b'\t', b'.', b'/', path @ ..] => (false, path),
                _ => return Err(failed),
            }
        };
        let path = std::str::from_utf8(path).map_err(|_| failed)?;
        if !normal_components(path) {
            return Err(failed);
        }
        // Same top-level exclusion as the legacy Git name index.
        let first = match path.split_once('/') {
            Some((first, _)) => first,
            None => path,
        };
        if matches!(
            first,
            ".git"
                | ".convex"
                | "node_modules"
                | ".next"
                | ".turbo"
                | "dist"
                | "build"
                | "out"
                | ".cache"
        ) {
            continue;
        }
        // Ancestors precede each inserted leaf even when find's batches arrive
        // out of order, so a truncated result cannot orphan a child.
        if !entries.insert_path(path, directory) {
            truncated = true;
            break;
        }
    }
    Ok(ProofWorkspaceIndexResult {
        entries: entries.paths.into_values().collect(),
        truncated,
    })
}

struct Entries {
    paths: BTreeMap<String, ProofWorkspaceIndexedEntry>,
    bytes_left: usize,
}

impl Entries {
    fn insert_path(&mut self, path: &str, directory: bool) -> bool {
        // A retained directory already has all its ancestors. Skip that prefix
        // when parsing many siblings in a deeply nested directory.
        let mut remaining = Vec::new();
        let mut child = path;
        while let Some((parent, _)) = child.rsplit_once('/') {
            if self.paths.get(parent).is_some_and(|entry| entry.directory) {
                break;
            }
            remaining.push(parent);
            child = parent;
        }
        remaining
            .into_iter()
            .rev()
            .all(|parent| self.insert(parent, true))
            && self.insert(path, directory)
    }

    fn insert(&mut self, path: &str, directory: bool) -> bool {
        if let Some(entry) = self.paths.get_mut(path) {
            if directory && !entry.directory {
                let before = repeated_entry_len(entry);
                entry.directory = true;
                let extra = repeated_entry_len(entry) - before;
                if let Some(remaining) = self.bytes_left.checked_sub(extra) {
                    self.bytes_left = remaining;
                } else {
                    entry.directory = false;
                    return false;
                }
            }
            return true;
        }
        if self.paths.len() >= MAX_ENTRIES {
            return false;
        }
        let entry = ProofWorkspaceIndexedEntry {
            path: path.to_owned(),
            directory,
        };
        let Some(remaining) = self.bytes_left.checked_sub(repeated_entry_len(&entry)) else {
            return false;
        };
        self.bytes_left = remaining;
        self.paths.insert(path.to_owned(), entry);
        true
    }
}

fn repeated_entry_len(entry: &ProofWorkspaceIndexedEntry) -> usize {
    let len = entry.encoded_len();
    1 + length_delimiter_len(len) + len // Repeated field tag, length, and message.
}

#[cfg(test)]
mod tests;
