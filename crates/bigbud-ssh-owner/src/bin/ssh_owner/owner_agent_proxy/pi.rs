//! Fixed Linux SSH proof for a startup-admitted Pi ELF, not a provider sandbox.
//! The SSH account and root are trusted, including the system loader, libraries,
//! and configuration outside the fixture. No production Pi home or credentials
//! are admitted by the recipe.

use super::{MAX_BINARY_BYTES, valid_sha256};
use std::{io, path::Path};

const MAX_PATH_BYTES: usize = 4095;

// Hash and execute the same open descriptor, never the original filename. The
// trusted SSH account must not mutate the admitted inode in place.
const SCRIPT: &str = concat!(
    r#"
[[ $# == 5 ]] || exit 126
binary=$1 expected=$2 cwd=$3 limit=$4 action=$5
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'

safe_home() {
    [[ ! -e .pi && ! -L .pi && ! -e .agents && ! -L .agents ]]
}

"#,
    include_str!("provider_elf_guard.sh"),
    r#"validate 2>/dev/null || exit 126
export HOME="$cwd"
unset PWD OLDPWD PATH
case "$action" in
    probe) exec "$fd" --version ;;
    start) exec "$fd" --mode rpc ;;
    *) exit 126 ;;
esac
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
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-pi-proof {} {} {} {MAX_BINARY_BYTES}",
            quote(SCRIPT),
            quote(binary),
            quote(sha),
            quote(cwd),
        );
        Ok(Self {
            binding: [binary, sha, cwd, thread].map(str::to_owned),
            epoch,
            probe: format!("{prefix} probe"),
            start: format!("{prefix} start"),
        })
    }

    /// Resuming from a session file is outside this proof, even for an empty
    /// operand. Callers must preserve presence when checking a start request.
    pub(super) fn matches_binding(
        &self,
        binary: &str,
        sha: &str,
        cwd: &str,
        thread: &str,
        epoch: u64,
        session_file: Option<&str>,
    ) -> bool {
        session_file.is_none() && self.binding == [binary, sha, cwd, thread] && self.epoch == epoch
    }

    pub(super) fn probe_command(&self) -> &str {
        &self.probe
    }

    pub(super) fn command(&self) -> &str {
        &self.start
    }
}

fn invalid_binding() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid proof Pi binding")
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
#[path = "pi/tests.rs"]
mod tests;
