trusted_dir() {
    local meta owner mode
    meta=$(/usr/bin/stat -c '%u:%f' -- "$1") || return 1
    owner=${meta%:*} mode=$((16#${meta#*:}))
    [[ $owner == 0 || $owner == "$EUID" ]] && (( (mode & 0170000) == 0040000 )) || return 1
    (( (mode & 0022) == 0 || (owner == 0 && (mode & 01000) != 0) ))
}

private_dir() {
    local rest=${1#/} dir= meta mode
    trusted_dir / || return 1
    while [[ -n $rest ]]; do
        dir+=/${rest%%/*}
        trusted_dir "$dir" || return 1
        if [[ $rest != */* ]]; then break; fi
        rest=${rest#*/}
    done
    meta=$(/usr/bin/stat -c '%u:%f' -- "${dir:-/}") || return 1
    mode=$((16#${meta#*:}))
    [[ ${meta%:*} == "$EUID" ]] && (( mode == 0040700 || mode == 0040500 ))
}

validate() {
    local parent=${binary%/*} before opened dev ino mode owner links size rest digest ident
    [[ $(/usr/bin/uname -s) == Linux ]] || return 1
    private_dir "${parent:-/}" && private_dir "$cwd" || return 1
    cd -P -- "$cwd" && [[ $PWD == "$cwd" ]] || return 1
    safe_home || return 1
    before=$(/usr/bin/stat -c "$fields" -- "$binary") || return 1
    IFS=: read -r dev ino mode owner links size rest <<< "$before" || return 1
    mode=$((16#$mode))
    [[ $owner == "$EUID" && $links == 1 ]] || return 1
    (( (mode == 0100700 || mode == 0100500) && size > 0 && size <= limit )) || return 1
    exec 9<"$binary" || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]] || return 1
    # Require ELF magic and a NUL in the first line of e_ident. This also
    # makes Bash refuse shell fallback if the kernel rejects a malformed ELF.
    IFS= read -r -d '' -n 16 ident < "$fd" || return 1
    [[ $ident == $'\x7fELF'* && $ident != *$'\n'* && ${#ident} -ge 7 && ${#ident} -lt 16 ]] || return 1
    digest=$(/usr/bin/head -c "$((limit + 1))" -- "$fd" | /usr/bin/sha256sum) || return 1
    [[ ${digest%% *} == "$expected" ]] || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]]
}

