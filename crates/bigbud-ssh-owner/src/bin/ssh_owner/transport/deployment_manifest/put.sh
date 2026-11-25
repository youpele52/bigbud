set -eu
umask 077
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
unset CDPATH

# Same trust model as begin: a disposable Linux fixture with no competing
# untrusted same-UID processes. Path inspection is not a same-UID sandbox.
[ "$#" -eq 4 ] || exit 64
case "$1" in /tmp/bigbud-picker-linux-*/deployment-graphs) ;; *) exit 70 ;; esac
container=${1%/deployment-graphs}
suffix=${container#/tmp/bigbud-picker-linux-}
case "$suffix" in ''|*[!a-zA-Z0-9]*) exit 70 ;; esac
[ "${#suffix}" -le 64 ] || exit 70

# Exact approval is checked by the owner; recheck filesystem-safe operands.
case "$2" in ????????-????-4???-[89ab]???-????????????) ;; *) exit 64 ;; esac
case "$2" in *[!a-f0-9-]*) exit 64 ;; esac
hex_id=$(printf '%s' "$2" | tr -d '-')
[ "${#hex_id}" -eq 32 ] || exit 64
case "$3" in ''|*[!a-f0-9]*) exit 64 ;; esac
[ "${#3}" -eq 64 ] || exit 64
case "$4" in ''|0*|*[!0-9]*) exit 64 ;; esac
[ "${#4}" -le 5 ] && [ "$4" -le 49152 ] || exit 64

[ "$(uname -s)" = Linux ] || exit 70
uid=$(id -u) || exit 70
[ "$uid" != 0 ] || exit 70
private_cd() {
  [ ! -L "$1" ] && [ -d "$1" ] && cd -P "$1" &&
    [ "$(pwd -P)" = "$2" ] && [ "$(stat -c '%u:%a' .)" = "$uid:700" ]
}
[ ! -L /tmp ] && cd -P /tmp && [ "$(pwd -P)" = /tmp ] || exit 70
private_cd "./${container##*/}" "$container" || exit 70
private_cd ./deployment-graphs "$1" || exit 70
private_cd "./.staging-$2" "$1/.staging-$2" || exit 73

file=./manifest.json
vacant() { [ ! -e "$file" ] && [ ! -L "$file" ]; }
vacant || exit 73
# mktemp creates the file exclusively. Cleanup unlinks only this invocation's
# temp name, never the stage, destination, or any leftovers from earlier runs.
temp=$(mktemp ./.manifest-put.XXXXXXXX) || exit 74
trap 'rm -f -- "$temp"' 0
trap 'exit 75' HUP INT TERM

# Read at most one byte beyond the declared length. A short input, including
# disconnect-induced EOF, or any trailing byte cannot publish a manifest.
head -c "$(($4 + 1))" > "$temp" || exit 74
size=$(wc -c < "$temp") || exit 74
[ "$size" -eq "$4" ] || exit 65
hash=$(sha256sum -- "$temp") || exit 74
[ "${hash%% *}" = "$3" ] || exit 65

# GNU ln -T without -f excludes overwrite, including a concurrent winner or a
# directory/directory symlink at the fixed destination. Never fall back to mv.
if ! ln -T -- "$temp" "$file"; then
  vacant || exit 73
  # Be conservative if a competing target disappeared or the result is unclear.
  exit 75
fi
rm -- "$temp" || exit 75
trap - 0
printf 'manifest-stored\n' || exit 75
