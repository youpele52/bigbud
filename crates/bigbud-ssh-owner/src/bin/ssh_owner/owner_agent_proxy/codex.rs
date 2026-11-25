//! Fixed Linux SSH proof for a startup-admitted Codex fixture, not a provider
//! sandbox. The SSH account and root are trusted, including the system loader,
//! libraries and system configuration. No credentials or production Codex
//! home are admitted by this recipe.

use super::{MAX_BINARY_BYTES, valid_sha256};
use std::io;
use std::path::Path;

const MAX_PATH_BYTES: usize = 4095;

// No argument can select a verb except the two owner-compiled recipes below.
// Hash and execute the same open file descriptor; never look up the original
// binary name again for execution. Refuse scripts and symlinks. The account
// must not mutate the admitted inode in place, including after the last stat.
const SCRIPT: &str = concat!(
    r#"
binary=$1 expected=$2 cwd=$3 limit=$4 verb=$5
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'

safe_home() {
    [[ ! -e .codex && ! -L .codex ]]
}

"#,
    include_str!("provider_elf_guard.sh"),
    r#"validate 2>/dev/null || exit 126
export HOME="$cwd"
unset PWD OLDPWD PATH
exec "$fd" "$verb"
"#
);

pub(super) struct Recipe {
    binding: [String; 4],
    epoch: u64,
    probe: String,
    start: String,
}

impl Recipe {
    pub(super) fn new(
        binary: &Path,
        sha: &str,
        cwd: &Path,
        thread: &str,
        epoch: u64,
    ) -> io::Result<Self> {
        let binary = exact_path(binary)?;
        let cwd = exact_path(cwd)?;
        if !valid_sha256(sha)
            || thread.is_empty()
            || thread.len() > 128
            || !thread.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(invalid_binding());
        }
        let prefix = format!(
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-codex-proof {} {} {} {MAX_BINARY_BYTES}",
            quote(SCRIPT),
            quote(binary),
            quote(sha),
            quote(cwd),
        );
        Ok(Self {
            binding: [binary, sha, cwd, thread].map(str::to_owned),
            epoch,
            probe: format!("{prefix} --version"),
            start: format!("{prefix} app-server"),
        })
    }

    pub(super) fn matches_binding(
        &self,
        binary: &str,
        sha: &str,
        cwd: &str,
        thread: &str,
        epoch: u64,
    ) -> bool {
        self.binding == [binary, sha, cwd, thread] && self.epoch == epoch
    }

    pub(super) fn probe_command(&self) -> &str {
        &self.probe
    }

    /// Only the baseline app-server verb is admitted. In particular the
    /// default-mode feature flag is unsupported and must be denied by the owner.
    pub(super) fn command(&self) -> &str {
        &self.start
    }
}

fn invalid_binding() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid proof Codex binding")
}

fn exact_path(path: &Path) -> io::Result<&str> {
    let path = path.to_str().ok_or_else(invalid_binding)?;
    let rest = path.strip_prefix('/').ok_or_else(invalid_binding)?;
    if path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || rest.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(invalid_binding());
    }
    Ok(path)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "codex/tests.rs"]
mod tests;
