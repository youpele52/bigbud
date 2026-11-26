//! Startup-bound receive-pack advertisement, not a writable Git transport.
//!
//! The ref and source OID bind admission to the exact initiating request. They
//! do not describe or constrain ref-update packets: no client bytes reach Git.
//! A pre-receive hook would run after client input and pack processing and
//! would require its own remote installation and enforcement proof.

use std::io;

#[cfg(target_os = "linux")]
#[path = "git_receive/fixture_launch.rs"]
pub(crate) mod fixture_launch;
#[cfg(any(target_os = "linux", test))]
#[path = "git_receive/tracked_push.rs"]
pub(crate) mod tracked_push;

// Run these checks on the SSH host, not against the owner's local filesystem.
// The host and fixture account are trusted; other accounts must not be able to
// replace a directory or fixture entry between validation and use. Once inside
// the checked repository, give Git `.` rather than resolving its path again.
const SCRIPT: &str = r#"
root=$1 repo=$2 format=$3
platform=$(/usr/bin/uname -s) || exit 126
shopt -s nullglob dotglob

metadata() {
    local acl
    case $platform in
        Linux) /usr/bin/stat -c '%u:%a:%h:%s' -- "$1" ;;
        Darwin)
            acl=$(/bin/ls -lde "$1") || return 1
            [[ $acl != *$'\n'* ]] || return 1
            /usr/bin/stat -f '%u:%p:%l:%z' "$1" ;;
        *) return 1 ;;
    esac
}

physical_path() {
    local rest=${repo#/} dir= part meta owner mode links size
    cd -P / || return 1
    while :; do
        [[ -d ${dir:-/} && ! -L ${dir:-/} ]] || return 1
        meta=$(metadata "${dir:-/}") || return 1
        IFS=: read -r owner mode links size <<< "$meta" || return 1
        if [[ $dir == "$root" ]]; then
            [[ $owner == "$EUID" ]] && (( (8#$mode & 0077) == 0 )) || return 1
        elif [[ $dir == "$repo" ]]; then
            [[ $owner == "$EUID" ]] && (( (8#$mode & 0022) == 0 )) || return 1
        else
            [[ $owner == "$EUID" || $owner == 0 ]] || return 1
            # A root-owned sticky ancestor (e.g. /tmp) protects a trusted next
            # entry against rename/removal by other accounts.
            (( (8#$mode & 0022) == 0 || (owner == 0 && (8#$mode & 01000) != 0) )) || return 1
        fi
        cd -P -- "${dir:-/}" && [[ $PWD == "${dir:-/}" ]] || return 1
        [[ $dir == "$repo" ]] && return 0
        part=${rest%%/*}
        dir+=/$part
        if [[ $rest == */* ]]; then rest=${rest#*/}; else rest=; fi
    done
}

regular_file() {
    local meta owner mode links size
    [[ -f $1 && ! -L $1 ]] || return 1
    meta=$(metadata "$1") || return 1
    IFS=: read -r owner mode links size <<< "$meta" || return 1
    [[ $owner == "$EUID" && $links == 1 ]] && (( (8#$mode & 0022) == 0 && size <= $2 ))
}

fixture_dir() {
    local meta owner mode links size
    [[ -d $1 && ! -L $1 && -r $1 && -x $1 ]] || return 1
    meta=$(metadata "$1") || return 1
    IFS=: read -r owner mode links size <<< "$meta" || return 1
    [[ $owner == "$EUID" ]] && (( (8#$mode & 0022) == 0 ))
}

entry_count() {
    local expected=$1
    shift
    [[ $# == "$expected" ]]
}

fixture_layout() {
    local core prefix= case_line precompose_line mode directory
    entry_count 4 ./* && fixture_dir ./objects && fixture_dir ./refs || return 1
    entry_count 2 ./objects/* && entry_count 2 ./refs/* || return 1
    for directory in ./objects/info ./objects/pack ./refs/heads ./refs/tags; do
        fixture_dir "$directory" || return 1
        # The private root excludes other accounts, and each leaf is empty:
        # no refs, alternates, hooks, .git indirection, or other Git metadata.
        entry_count 0 "$directory"/* || return 1
    done
    regular_file ./HEAD 21 && regular_file ./config 256 || return 1
    printf 'ref: refs/heads/main\n' | /usr/bin/cmp -s ./HEAD - || return 1
    case $format in
        sha1) core=$'[core]\n\trepositoryformatversion = 0\n' ;;
        sha256)
            prefix=$'[extensions]\n\tobjectformat = sha256\n'
            core=$'[core]\n\trepositoryformatversion = 1\n' ;;
        *) return 1 ;;
    esac
    # Match complete bytes, not parsed config; Git never sees an unchecked
    # include, extension or other setting. These are empty git-init fixtures.
    # Git 2.52 writes `[extensions]` before `[core]`; Git 2.47 (Debian 13)
    # writes it after, so both exact layouts are accepted.
    for mode in true false; do
        for case_line in '' $'\tignorecase = true\n'; do
            for precompose_line in '' $'\tprecomposeunicode = true\n'; do
                if printf '%s%s\tfilemode = %s\n\tbare = true\n%s%s' \
                    "$prefix" "$core" "$mode" "$case_line" "$precompose_line" | /usr/bin/cmp -s ./config - ||
                    printf '%s\tfilemode = %s\n\tbare = true\n%s%s%s' \
                    "$core" "$mode" "$case_line" "$precompose_line" "$prefix" | /usr/bin/cmp -s ./config -; then
                    return 0
                fi
            done
        done
    done
    return 1
}

{ physical_path && fixture_layout; } 2>/dev/null || exit 126
exec /usr/bin/git-receive-pack --advertise-refs . </dev/null
"#;

pub(in super::super) struct Recipe {
    binding: [String; 3],
    command: String,
}

impl Recipe {
    pub(in super::super) fn new(
        fixture_root: &str,
        repository_path: &str,
        destination_ref: &str,
        source_oid: &str,
    ) -> io::Result<Self> {
        if !exact_path(fixture_root)
            || !exact_path(repository_path)
            || !repository_path
                .strip_prefix(fixture_root)
                .is_some_and(|rest| rest.starts_with('/'))
            || !valid_branch_ref(destination_ref)
            || !matches!(source_oid.len(), 40 | 64)
            || !source_oid
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            || source_oid.bytes().all(|byte| byte == b'0')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Git receive advertisement binding",
            ));
        }
        let object_format = if source_oid.len() == 40 {
            "sha1"
        } else {
            "sha256"
        };
        let command = format!(
            "exec /usr/bin/env -i LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
             /bin/bash -c {} bigbud-git-receive-advertisement {} {} {object_format} </dev/null",
            quote(SCRIPT),
            quote(fixture_root),
            quote(repository_path),
        );
        Ok(Self {
            binding: [repository_path, destination_ref, source_oid].map(str::to_owned),
            command,
        })
    }

    pub(in super::super) fn matches_binding(
        &self,
        repository_path: &str,
        destination_ref: &str,
        source_oid: &str,
    ) -> bool {
        self.binding == [repository_path, destination_ref, source_oid]
    }

    pub(in super::super) fn command(&self) -> &str {
        &self.command
    }
}

fn exact_path(path: &str) -> bool {
    path.len() <= 4095
        && !path.chars().any(char::is_control)
        && path
            .strip_prefix('/')
            .is_some_and(|rest| !rest.split('/').any(|part| matches!(part, "" | "." | "..")))
}

fn valid_branch_ref(reference: &str) -> bool {
    reference.len() <= 1024
        && !reference.ends_with('.')
        && !reference.contains("..")
        && !reference.contains("@{")
        && !reference
            .chars()
            .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
        && reference.strip_prefix("refs/heads/").is_some_and(|rest| {
            rest.split('/')
                .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
        })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "git_receive/tests.rs"]
mod tests;
