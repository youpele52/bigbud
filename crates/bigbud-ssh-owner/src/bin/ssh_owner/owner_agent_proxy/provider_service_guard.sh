trusted_dir() {
    local meta owner mode
    meta=$(/usr/bin/stat -c '%u:%f' -- "$1") || return 1
    owner=${meta%:*} mode=$((16#${meta#*:}))
    [[ $owner == 0 || $owner == "$EUID" ]] && (( (mode & 0170000) == 0040000 )) || return 1
    (( (mode & 0022) == 0 || (owner == 0 && (mode & 01000) != 0) ))
}

trusted_path() {
    local rest=${1#/} dir=
    trusted_dir / || return 1
    while [[ -n $rest ]]; do
        dir+=/${rest%%/*}
        trusted_dir "$dir" || return 1
        if [[ $rest != */* ]]; then break; fi
        rest=${rest#*/}
    done
}

# Configured absolute executable: no digest pin is possible before the provider
# setting exists, so directory and inode identity plus ELF identity are required
# and the opened descriptor is executed, never the path.
validate() {
    local parent=${binary%/*} before opened dev ino mode owner links size rest ident
    [[ $(/usr/bin/uname -s) == Linux ]] || return 1
    trusted_path "${parent:-/}" && trusted_path "$cwd" || return 1
    cd -P -- "$cwd" && [[ $PWD == "$cwd" ]] || return 1
    before=$(/usr/bin/stat -c "$fields" -- "$binary") || return 1
    IFS=: read -r dev ino mode owner links size rest <<< "$before" || return 1
    mode=$((16#$mode))
    [[ -n $size && $size -gt 0 && $size -le $limit && $links == 1 ]] || return 1
    (( (mode & 0170000) == 0100000 )) || return 1
    (( (mode & 0100) != 0 )) || return 1
    (( (mode & 0022) == 0 )) || return 1
    [[ $owner == 0 || $owner == "$EUID" ]] || return 1
    exec 9<"$binary" || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]] || return 1
    IFS= read -r -d '' -n 16 ident < "$fd" || return 1
    [[ $ident == $'\x7fELF'* && $ident != *$'\n'* && ${#ident} -ge 7 && ${#ident} -lt 16 ]] || return 1
    opened=$(/usr/bin/stat -Lc "$fields" -- "$fd") || return 1
    [[ $before == "$opened" ]]
}
