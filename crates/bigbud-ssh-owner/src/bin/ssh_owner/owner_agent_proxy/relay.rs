//! Fixed Linux recipe for an admitted installed client relay. The SSH account
//! and root are trusted, as in the installed agent recipe. The remaining module
//! graph is covered by installation admission, not by these two entry pins.

use super::{MAX_BINARY_BYTES, valid_sha256};
use std::io;
use std::path::Path;

const MAX_PATH_BYTES: usize = 4095;
const MAX_HELPER_BYTES: usize = 16 * 1024 * 1024;

// Node must load the real ESM main URL, not /proc/self/fd/8 or stdin. The
// former breaks graph-relative resolution; the latter also consumes relay
// traffic. This fixed preload serves the main module from a verified snapshot
// of the same descriptor Bash opened. All other loads use Node's own resolver.
// If synchronous hooks are unsupported, Node fails before executing the entry.
const PRELOAD: &str = r#"
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, readSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

function unavailable() { throw new Error('Remote backend client relay unavailable.'); }

const expected = process.env.BIGBUD_RELAY_HELPER_SHA256;
const limit = Number(process.env.BIGBUD_RELAY_HELPER_MAX_BYTES);
delete process.env.BIGBUD_RELAY_HELPER_SHA256;
delete process.env.BIGBUD_RELAY_HELPER_MAX_BYTES;
const url = pathToFileURL(process.argv[1]).href;
const fd = 8;
const source = (() => {
    try {
        const { size } = fstatSync(fd);
        if (!Number.isSafeInteger(limit) || size < 1 || size > limit) unavailable();
        const bytes = Buffer.alloc(size);
        for (let pos = 0; pos < size;) {
            const n = readSync(fd, bytes, pos, size - pos, pos);
            if (n === 0) unavailable();
            pos += n;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0 ||
            createHash('sha256').update(bytes).digest('hex') !== expected) unavailable();
        return bytes;
    } finally {
        closeSync(fd);
        closeSync(9);
    }
})();
let mainPending = true;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (mainPending && context.parentURL === undefined) {
            if (specifier !== url) unavailable();
            mainPending = false;
            return { url, format: 'module', shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
    load(resolved, context, nextLoad) {
        if (resolved === url) return { format: 'module', source, shortCircuit: true };
        return nextLoad(resolved, context);
    },
});
"#;

const SCRIPT: &str = r#"
node=$1 node_sha=$2 helper=$3 helper_sha=$4 authority=$5 node_limit=$6 helper_limit=$7 preload=$8
node_fd=/proc/self/fd/9 helper_fd=/proc/self/fd/8
fields='%f:%u:%h:%s:%d:%i:%y:%z'

trusted_dir() {
    local meta owner mode
    meta=$(/usr/bin/stat -c '%u:%f' -- "$1") || return 1
    owner=${meta%:*} mode=$((16#${meta#*:}))
    [[ $owner == 0 || $owner == "$EUID" ]] && (( (mode & 0170000) == 0040000 )) || return 1
    (( (mode & 0022) == 0 || (owner == 0 && (mode & 01000) != 0) ))
}

trusted_parents() {
    local rest=${1#/} dir= meta
    trusted_dir / || return 1
    while [[ -n $rest ]]; do
        dir+=/${rest%%/*}
        trusted_dir "$dir" || return 1
        if [[ $rest != */* ]]; then break; fi
        rest=${rest#*/}
    done
    # The immediate directory may contain imports. A sticky shared directory
    # is suitable as an ancestor only, never as a module search directory.
    meta=$(/usr/bin/stat -c '%f' -- "${dir:-/}") || return 1
    (( (16#$meta & 0022) == 0 ))
}

file_identity() {
    local meta owner mode links size rest
    meta=$(/usr/bin/stat -c "$fields" -- "$1") || return 1
    IFS=: read -r mode owner links size rest <<< "$meta" || return 1
    mode=$((16#$mode))
    [[ $owner == 0 || $owner == "$EUID" ]] && [[ $links == 1 ]] || return 1
    (( (mode & 0170000) == 0100000 && (mode & 07022) == 0 && size > 0 && size <= $2 )) || return 1
    printf '%s' "$meta"
}

check_digest() {
    local opened digest
    opened=$(/usr/bin/stat -Lc "$fields" -- "$1") || return 1
    [[ $opened == "$2" ]] || return 1
    digest=$(/usr/bin/head -c "$(($4 + 1))" -- "$1" | /usr/bin/sha256sum) || return 1
    [[ ${digest%% *} == "$3" ]] || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$1") || return 1
    [[ $opened == "$2" ]]
}

validate() {
    local node_parent=${node%/*} helper_parent=${helper%/*} node_before helper_before
    trusted_parents "${node_parent:-/}" && trusted_parents "${helper_parent:-/}" || return 1
    node_before=$(file_identity "$node" "$node_limit") || return 1
    helper_before=$(file_identity "$helper" "$helper_limit") || return 1
    exec 9<"$node" 8<"$helper" || return 1
    check_digest "$node_fd" "$node_before" "$node_sha" "$node_limit" || return 1
    check_digest "$helper_fd" "$helper_before" "$helper_sha" "$helper_limit" || return 1
    # Do not let Bash interpret a script or let a shebang select an interpreter.
    [[ $(/usr/bin/head -c 4 -- "$node_fd") == $'\x7fELF' ]]
}

validate 2>/dev/null || exit 126
BIGBUD_RELAY_HELPER_SHA256=$helper_sha BIGBUD_RELAY_HELPER_MAX_BYTES=$helper_limit \
    exec "$node_fd" --preserve-symlinks-main --import "$preload" -- "$helper" "$authority"
"#;

pub(crate) struct Recipe {
    binding: [String; 5],
    command: String,
}

impl Recipe {
    pub(crate) fn new(
        node: &Path,
        node_sha256: &str,
        helper: &Path,
        helper_sha256: &str,
        authority_id: &str,
    ) -> io::Result<Self> {
        let node = exact_path(node)?;
        let helper = exact_path(helper)?;
        if !helper.ends_with(".mjs")
            || !valid_sha256(node_sha256)
            || !valid_sha256(helper_sha256)
            || authority_id.len() != 32
            || !authority_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(invalid_binding());
        }
        let binding = [node, node_sha256, helper, helper_sha256, authority_id];
        let [node, node_sha256, helper, helper_sha256, authority_id] = binding.map(quote);
        let command = format!(
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-client-relay \
             {node} {node_sha256} {helper} {helper_sha256} {authority_id} \
             {MAX_BINARY_BYTES} {MAX_HELPER_BYTES} {}",
            quote(SCRIPT),
            quote(&preload_url()),
        );
        Ok(Self {
            binding: binding.map(str::to_owned),
            command,
        })
    }

    pub(super) fn matches_binding(
        &self,
        node: &str,
        node_sha256: &str,
        helper: &str,
        helper_sha256: &str,
        authority_id: &str,
    ) -> bool {
        self.binding == [node, node_sha256, helper, helper_sha256, authority_id]
    }

    pub(crate) fn command(&self) -> &str {
        &self.command
    }
}

fn preload_url() -> String {
    fn hex_digit(byte: u8) -> char {
        let nibble = byte & 0xf;
        char::from(if nibble < 10 {
            b'0' + nibble
        } else {
            b'A' + (nibble - 10)
        })
    }

    let mut url = String::from("data:text/javascript,");
    url.reserve(PRELOAD.len() * 3);
    for byte in PRELOAD.bytes() {
        url.push('%');
        url.push(hex_digit(byte >> 4));
        url.push(hex_digit(byte));
    }
    url
}

fn invalid_binding() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid installed relay binding",
    )
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
#[path = "relay/tests.rs"]
mod tests;
