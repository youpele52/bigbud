# Shared provider discovery and login environment (Pi, Codex, OpenCode v2).
# Needs `validate` (provider_service_guard.sh), `limit`, and the callers'
# `configured` (an explicit path, or empty) and `extra_candidates` (newline
# list, or empty). No request names a program.
#
# A candidate runs if it passes the shared trusted-path, size and ELF guard
# (fd 9 is the opened executable), or (U19, like the old path) if it is an npm
# launcher: a `#!…node` file inside a `node_modules` package runs as
# `node ENTRY`, with a node binary that passes the same guard.
login_candidate() {
    if [[ $SHELL == /* && -x $SHELL ]]; then
        /usr/bin/timeout -s KILL 5 "$SHELL" -lc "command -v $1" </dev/null 2>/dev/null |
            /usr/bin/head -c 4096 | /usr/bin/tail -n 1
    fi
}

known_candidates() {
    printf '%s\n' "$HOME/.local/bin/$1" "$HOME/bin/$1" "/usr/local/bin/$1" "/usr/bin/$1"
}

candidates() {
    if [[ -n $configured ]]; then
        printf '%s\n' "$configured"
        return
    fi
    login_candidate "$1"
    [[ -z $extra_candidates ]] || printf '%s\n' "$extra_candidates"
    known_candidates "$1"
}

# A JS entry of an npm package: a regular single-link file in a trusted
# directory chain inside `node_modules`, owner- or root-owned, not writable by
# group or others, at most `limit` bytes, whose first line is a node shebang.
npm_entry() {
    local file=$1 meta owner mode links size line
    [[ $file == */node_modules/* && -f $file && ! -L $file ]] || return 1
    trusted_path "${file%/*}" || return 1
    meta=$(/usr/bin/stat -c '%u:%f:%h:%s' -- "$file") || return 1
    IFS=: read -r owner mode links size <<< "$meta" || return 1
    mode=$((16#$mode))
    [[ ($owner == 0 || $owner == "$EUID") && $links == 1 && $size -le $limit ]] || return 1
    (( (mode & 0022) == 0 )) || return 1
    IFS= read -r line < "$file" || return 1
    [[ $line =~ ^\#\!.*[/\ ]node([[:space:]].*)?$ ]]
}

# Sets `binary` (validated, opened as fd 9) and `entry` (empty for an ELF).
select_binary() {
    local candidate resolved node
    entry=
    while IFS= read -r candidate; do
        [[ $candidate == /* ]] || continue
        resolved=$(/usr/bin/readlink -e -- "$candidate") || continue
        binary=$resolved
        if validate 2>/dev/null; then
            return 0
        fi
        exec 9<&-
        npm_entry "$resolved" 2>/dev/null || continue
        while IFS= read -r node; do
            [[ $node == /* ]] || continue
            binary=$(/usr/bin/readlink -e -- "$node") || continue
            if validate 2>/dev/null; then
                entry=$resolved
                return 0
            fi
            exec 9<&-
        done < <(login_candidate node; known_candidates node)
    done < <(candidates "$1")
    return 1
}

# U19: the account's login environment, captured on its own so nothing a
# profile prints can reach the provider's stdout: the login shell's stdout and
# stderr are discarded and only `env -0` is read, from fd 3, bounded at 5 s and
# 64 KiB. Fills `login_env` (KEY=VALUE entries, without `LC_ALL`); fails if the
# capture timed out, overflowed or has no PATH.
capture_login_env() {
    local raw total=0 item
    login_env=()
    mapfile -d '' -t raw < <(
        /usr/bin/timeout -s KILL 5 /bin/sh -lc 'exec /usr/bin/env -0 >&3' \
            3>&1 1>/dev/null 2>/dev/null </dev/null | /usr/bin/head -c 65537
    )
    for item in "${raw[@]}"; do
        total=$(( total + ${#item} + 1 ))
        [[ $item == *=* && $item != LC_ALL=* && $item != _=* && $item != LANG= ]] || continue
        login_env+=("$item")
    done
    (( total > 0 && total <= 65536 )) || return 1
    [[ " ${login_env[*]%%=*} " == *" PATH "* ]]
}
