# Owner-shipped executable selection. An explicit configured path is the only
# candidate; otherwise the target's own login environment (`command -v`, bounded)
# and the known install locations are tried. Every candidate is resolved to its
# real path and must pass the same trusted-path, size and ELF guard.
missing() {
    printf '\nbigbud-opencode-v2 %s missing\n' "$nonce" >&2
    exit 125
}

candidates() {
    if [[ -n $configured ]]; then
        printf '%s\n' "$configured"
        return
    fi
    if [[ $SHELL == /* && -x $SHELL ]]; then
        /usr/bin/timeout -s KILL 5 "$SHELL" -lc 'command -v opencode' </dev/null 2>/dev/null |
            /usr/bin/head -c 4096 | /usr/bin/tail -n 1
    fi
    printf '%s\n' "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" \
        "$HOME/bin/opencode" /usr/local/bin/opencode /usr/bin/opencode
}

select_binary() {
    local candidate resolved
    while IFS= read -r candidate; do
        [[ $candidate == /* ]] || continue
        resolved=$(/usr/bin/readlink -e -- "$candidate") || continue
        binary=$resolved
        if validate 2>/dev/null; then
            return 0
        fi
        exec 9<&-
    done < <(candidates)
    return 1
}
