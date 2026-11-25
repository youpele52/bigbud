# This script runs on the disposable SSH host, not on the owner machine.
# The host and fixture account are trusted. The private physical root excludes
# other accounts from replacing entries between validation and Git's reads.
[[ $(/usr/bin/uname -s) == Linux ]] || exit 126
root=$1 repo=$2

trusted_ancestor() {
    local meta owner mode
    [[ ! -L $1 && -d $1 ]] || return 1
    meta=$(/usr/bin/stat -c '%u:%a' -- "$1") || return 1
    IFS=: read -r owner mode <<< "$meta" || return 1
    [[ $owner == 0 || $owner == "$EUID" ]] || return 1
    # A root-owned sticky ancestor such as /tmp protects the owned fixture
    # directory from rename or removal by an untrusted account.
    (( (8#$mode & 0022) == 0 || (owner == 0 && (8#$mode & 01000) != 0) ))
}

fixture_dir() {
    local meta owner mode
    [[ ! -L $1 && -d $1 && -r $1 && -x $1 ]] || return 1
    meta=$(/usr/bin/stat -c '%u:%a' -- "$1") || return 1
    IFS=: read -r owner mode <<< "$meta" || return 1
    [[ $owner == "$EUID" ]] && (( (8#$mode & $2) == 0 ))
}

fixture_file() {
    local meta owner mode links size
    [[ ! -L $1 && -f $1 && -r $1 ]] || return 1
    meta=$(/usr/bin/stat -c '%u:%a:%h:%s' -- "$1") || return 1
    IFS=: read -r owner mode links size <<< "$meta" || return 1
    [[ $owner == "$EUID" && $links == 1 ]] && (( (8#$mode & 0022) == 0 && size <= $2 ))
}

no_unexpected_entries() {
    local directory=$1 unexpected
    shift
    # Do not expand globs: stop at the first unexpected entry even if someone
    # incorrectly points startup at a large repository. Only one byte is read.
    unexpected=$(/usr/bin/find "$directory" -mindepth 1 -maxdepth 1 "$@" -printf x -quit) &&
        [[ -z $unexpected ]]
}

enter_fixture() {
    trusted_ancestor / && trusted_ancestor /tmp || return 1
    fixture_dir "$root" 0077 && fixture_dir "$repo" 0022 || return 1
    cd -P -- "$repo" && [[ $PWD == "$repo" ]]
}

base_bare_layout() {
    local directory mode
    no_unexpected_entries . ! -name HEAD ! -name config ! -name objects ! -name refs || return 1
    for directory in ./objects ./refs ./objects/info ./objects/pack ./refs/heads ./refs/tags; do
        fixture_dir "$directory" 0022 || return 1
    done
    no_unexpected_entries ./refs ! -name heads ! -name tags || return 1
    for directory in ./objects/info ./objects/pack ./refs/tags; do
        no_unexpected_entries "$directory" || return 1
    done
    fixture_file ./HEAD 21 && fixture_file ./config 256 || return 1
    printf 'ref: refs/heads/main\n' | /usr/bin/cmp -s ./HEAD - || return 1
    # Allow complete config bytes only, never includes, hooksPath, promisor
    # remotes, alternate object storage, or upload-pack configuration.
    for mode in true false; do
        if printf '[core]\n\trepositoryformatversion = 0\n\tfilemode = %s\n\tbare = true\n' "$mode" |
            /usr/bin/cmp -s ./config -; then
            return 0
        fi
    done
    return 1
}

empty_seed() {
    no_unexpected_entries ./objects ! -name info ! -name pack &&
        no_unexpected_entries ./refs/heads
}

fetch_seed() {
    # Only the synthetic root commit, one tree, and one blob from the
    # nonempty proof are admissible, not arbitrary repositories in /tmp.
    local commit=9ec7dd5a0eac6c3574466234c87edb5f59dda27b
    local tree=affb622093ca6811a51164d7742ab0370f3648a4
    local blob=cd831874b19ebd93078e9bd170e70877f20e6719
    local oid fanout leaf
    no_unexpected_entries ./refs/heads ! -name main || return 1
    fixture_file ./refs/heads/main 41 || return 1
    printf '%s\n' "$commit" | /usr/bin/cmp -s ./refs/heads/main - || return 1
    no_unexpected_entries ./objects ! -name info ! -name pack \
        ! -name "${commit:0:2}" ! -name "${tree:0:2}" ! -name "${blob:0:2}" || return 1
    for oid in "$commit" "$tree" "$blob"; do
        fanout=./objects/${oid:0:2}
        leaf=${oid:2}
        fixture_dir "$fanout" 0022 && fixture_file "$fanout/$leaf" 256 || return 1
        no_unexpected_entries "$fanout" ! -name "$leaf" || return 1
    done
    # File names alone do not prove object identity or connectivity. Keep
    # validation bounded even if an object header claims an oversized body.
    (
        ulimit -v 131072 || exit 1
        /usr/bin/timeout --kill-after=1s 5s /usr/bin/git --git-dir=. fsck --strict --full --no-reflogs
    ) </dev/null
}

{ enter_fixture && base_bare_layout && { empty_seed || fetch_seed; }; } >/dev/null 2>&1 || exit 126
# No stdin redirection and no advertisement-only or stateless mode: Git owns
# the byte stream in both directions. Bound idle time and total service time.
export GIT_PROTOCOL=version=2
exec /usr/bin/timeout --kill-after=2s 30s /usr/bin/git-upload-pack --strict --timeout=15 .
