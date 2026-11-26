missing() {
    printf '\nbigbud-provider-lease %s missing\n' "$nonce" >&2
    exit 125
}

# A resume file must resolve beneath the account's own Pi sessions directory,
# and a Codex home to an existing directory beneath the account's home; both
# are resolved with every symlink followed, so a link cannot escape.
inside() {
    local root resolved
    root=$(/usr/bin/readlink -e -- "$2") && resolved=$(/usr/bin/readlink -e -- "$1") || return 1
    [[ $resolved == "$root"/* ]] && printf '%s\n' "$resolved"
}

[[ $(/usr/bin/uname -s) == Linux ]] || exit 126
{ trusted_path "$cwd" && cd -P -- "$cwd" && [[ $PWD == "$cwd" ]]; } 2>/dev/null || exit 126
if [[ -n $resume ]]; then
    [[ $provider == pi ]] || exit 126
    resume=$(inside "$resume" "$HOME/.pi/agent/sessions") && [[ -f $resume ]] || exit 126
fi
if [[ -n $codex_home ]]; then
    [[ $provider == codex ]] || exit 126
    codex_home=$(inside "$codex_home" "$HOME") && [[ -d $codex_home ]] || exit 126
    export CODEX_HOME=$codex_home
fi
select_binary "$provider" || missing
unset PWD OLDPWD
[[ $action == probe ]] || [[ $question == 0 || $provider == codex ]] || exit 126
case $provider:$action in
    pi:probe | codex:probe) args=(--version) ;;
    pi:start) args=(--mode rpc) && [[ -z $resume ]] || args+=(--session "$resume") ;;
    codex:start) args=(app-server) && [[ $question == 0 ]] ||
        args+=(-c features.default_mode_request_user_input=true) ;;
    *) exit 126 ;;
esac
[[ -z $entry ]] || args=("$entry" "${args[@]}")
# U19: the provider runs in the account's login environment, captured apart
# from any profile output, with the owner-selected executable and argv. A start
# runs under the shared remote session guard: its own process group, killed
# when this SSH session disappears (owner crash or channel loss).
capture_login_env || exit 126
run=(/usr/bin/env -i -- "${login_env[@]}" "$fd" "${args[@]}")
if [[ $action == probe ]]; then exec "${run[@]}"; fi
session_guard 0 "${run[@]}"
exit
