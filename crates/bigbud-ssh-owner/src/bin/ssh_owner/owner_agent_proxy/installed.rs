//! Fixed Debian guest recipe. The owner and sshd need not share a mount namespace.

use super::{MAX_BINARY_BYTES, valid_sha256};
use std::io;
use std::path::Path;

const MAX_PATH_BYTES: usize = 4095;
// Linux sockaddr_un.sun_path includes the terminating NUL.
const MAX_STATE_BYTES: usize = 107 - "/supervisor.sock".len();

// Trust root and the SSH account, not other users. A root-owned sticky
// directory (e.g. /tmp) is safe only because each child is checked as well.
// Execute the same opened inode that was hashed, not a second pathname lookup.
// This is not a security boundary against the remote account itself or root.
const SCRIPT: &str = r#"
binary=$1 expected=$2 state=$3 limit=$4
fd=/proc/self/fd/9

trusted_dir() {
    [[ ! -L $1 && -d $1 ]] || return 1
    local meta owner mode
    meta=$(/usr/bin/stat -c '%u:%a' -- "$1") || return 1
    owner=${meta%:*} mode=${meta#*:}
    [[ $owner == 0 || $owner == "$EUID" ]] || return 1
    (( (8#$mode & 0022) == 0 || (owner == 0 && (8#$mode & 01000) != 0) ))
}

private_dir() {
    local rest=${1#/} dir= meta
    trusted_dir / || return 1
    while [[ -n $rest ]]; do
        dir+=/${rest%%/*}
        trusted_dir "$dir" || return 1
        if [[ $rest != */* ]]; then break; fi
        rest=${rest#*/}
    done
    meta=$(/usr/bin/stat -c '%u:%a' -- "$1") || return 1
    [[ $meta == "$EUID:700" || $meta == "$EUID:500" ]]
}

validate() {
    local parent=${binary%/*} socket=$state/supervisor.sock before opened meta size digest
    private_dir "${parent:-/}" && private_dir "$state" || return 1
    [[ ! -L $socket && -S $socket ]] || return 1
    meta=$(/usr/bin/stat -c '%u:%a' -- "$socket") || return 1
    [[ $meta == "$EUID:700" ]] || return 1
    [[ ! -L $binary && -f $binary ]] || return 1
    meta=$(/usr/bin/stat -c '%u:%a:%h:%s' -- "$binary") || return 1
    size=${meta##*:}
    [[ $meta == "$EUID:500:1:$size" || $meta == "$EUID:700:1:$size" ]] || return 1
    (( size > 0 && size <= limit )) || return 1
    local fields='%d:%i:%f:%u:%h:%s:%y:%z'
    before=$(/usr/bin/stat -c "$fields" -- "$binary") || return 1
    exec 9<"$binary" || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]] || return 1
    digest=$(/usr/bin/head -c "$((limit + 1))" -- "$fd" | /usr/bin/sha256sum) || return 1
    [[ ${digest%% *} == "$expected" ]] || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]]
}

validate 2>/dev/null || exit 126
BIGBUD_AGENT_STATE_DIR=$state exec "$fd" --proxy
"#;

#[derive(Debug)]
pub(super) struct Recipe(String);

impl Recipe {
    pub(super) fn new(binary: &Path, sha256: &str, state: &Path) -> io::Result<Self> {
        let binary = exact_path(binary, MAX_PATH_BYTES)?;
        let state = exact_path(state, MAX_STATE_BYTES)?;
        if !valid_sha256(sha256) {
            return Err(invalid_binding());
        }
        Ok(Self(format!(
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-agent-proxy {} {} {} {}",
            quote(SCRIPT),
            quote(binary),
            quote(sha256),
            quote(state),
            MAX_BINARY_BYTES,
        )))
    }

    pub(super) fn command(&self) -> &str {
        &self.0
    }
}

fn invalid_binding() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid installed agent binding",
    )
}

fn exact_path(path: &Path, max_bytes: usize) -> io::Result<&str> {
    let path = path.to_str().ok_or_else(invalid_binding)?;
    let rest = path.strip_prefix('/').ok_or_else(invalid_binding)?;
    if path.len() > max_bytes
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
#[path = "installed/tests.rs"]
mod tests;
