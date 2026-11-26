# Read only: missing reservation directories are not created.
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
CDPATH=
export PATH LC_ALL CDPATH

case "$(uname -s)" in Linux) ;; *) exit 10 ;; esac
uid=$(id -u)
home=$(getent passwd "$uid" 2>/dev/null | cut -d: -f6)
if [ -z "$home" ]; then home=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd); fi
case "$home" in /*) ;; *) exit 13 ;; esac
raw=
for file in /etc/machine-id /var/lib/dbus/machine-id; do
  candidate=$(head -c 128 -- "$file" 2>/dev/null | tr 'A-F' 'a-f')
  if printf '%s\n' "$candidate" | grep -Eqx '[0-9a-f]{32}'; then raw=$candidate; break; fi
done
[ -n "$raw" ] || exit 11
host=$(printf 'bigbud.machine-identity.v1\000%s' "$raw" | sha256sum | cut -d' ' -f1)
# The appended sentinel keeps command substitution from removing newlines from a path.
real=$(cd -P -- "$1" 2>/dev/null && pwd -P && printf '.') || exit 12
real=${real%??}
# The response is a single line for the root. Refuse control bytes before framing.
case "$real" in /*) ;; *) exit 13 ;; esac
checked=$(printf '%s' "$real" | tr -d '[:cntrl:]')
[ "$checked" = "$real" ] || exit 13
rsha=$(printf '%s' "$real" | sha256sum | cut -d' ' -f1)
key=$(printf 'machine-v1:%s\n%s\n%s' "$host" "$uid" "$rsha" | sha256sum | cut -d' ' -f1)

ready() { printf 'bigbud.workspace-mode.inspect.v1 %s %s %s %s\n%s\n' "$host" "$uid" "$rsha" "$1" "$real"; }
owned_dir() {
  [ ! -L "$1" ] || exit 13
  if [ ! -e "$1" ]; then ready 0; exit 0; fi
  # The optional mode check is for workspace-mode directories, not .bigbud itself.
  shift_path=$1; shift
  [ -n "$(find "$shift_path" -maxdepth 0 -type d -uid "$uid" "$@" -printf x)" ] || exit 13
}
owned_dir "$home/.bigbud"
owned_dir "$home/.bigbud/workspace-modes" -perm 700
dir="$home/.bigbud/workspace-modes/$key"
owned_dir "$dir" -perm 700

latest=0
for file in "$dir"/*.json; do
  n=${file##*/}; n=${n%.json}
  case "$n" in ''|0*|*[!0-9]*) continue ;; esac
  [ "${#n}" -le 16 ] || continue
  if [ "$n" -gt "$latest" ]; then latest=$n; fi
done
if [ "$latest" = 0 ]; then ready 0; exit 0; fi
file="$dir/$latest.json"
if [ ! -e "$file" ] && [ ! -L "$file" ]; then exit 14; fi
[ -n "$(find "$file" -maxdepth 0 -type f -uid "$uid" -perm 600 -printf x)" ] || exit 13
[ -z "$(find "$file" -maxdepth 0 -size +1024c -printf x)" ] || exit 13
[ -s "$file" ] || exit 14
ready "$latest"
# A sentinel byte lets the native decoder distinguish an oversized record from a full read.
# nofollow/nonblock also prevents following a replaced symlink or blocking on a replaced FIFO.
if ! dd if="$file" bs=1025 count=1 iflag=fullblock,nofollow,nonblock status=none 2>/dev/null; then
  exit 14
fi
