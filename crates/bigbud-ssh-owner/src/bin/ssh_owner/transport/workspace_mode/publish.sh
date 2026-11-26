# Appended to the exact inspect recipe (wrapped as inspect()). Inputs have been validated natively.
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
CDPATH=
export PATH LC_ALL CDPATH
umask 077

root=$1 real=$2 host=$3 uid=$4 rsha=$5 generation=$6 previous=$7 next=$8
verdict() { printf 'bigbud.workspace-mode.publish.v1 %s\n' "$1"; exit 0; }
# Encode before command substitution so NULs or trailing newlines in a malformed on-disk
# record cannot be silently dropped. The fixed-width suffix carries inspect's exit status.
expected=$(printf 'bigbud.workspace-mode.inspect.v1 %s %s %s %s\n%s\n%s:000' \
  "$host" "$uid" "$rsha" "$generation" "$real" "$previous" | base64 -w0)
observe() {
  actual=$({ set +e; (inspect "$root"); status=$?; printf ':%03d' "$status"; } | base64 -w0)
}
changed() {
  # The native decoder verifies the full inspect frame and reports CAS conflict only for
  # a valid newer generation with the same physical root and identity.
  printf 'bigbud.workspace-mode.publish.v1 compare\n'
  printf '%s' "$actual" | base64 -d | head -c -4
  printf '\nbigbud.workspace-mode.publish.v1 end\n'
  exit 0
}
compare() {
  observe
  if [ "$actual" = "$expected" ]; then return; fi
  status=$(printf '%s' "$actual" | base64 -d | tail -c 4)
  case "$status" in
    :000) changed ;;
    :010) verdict not-linux ;;
    :011) verdict no-machine-id ;;
    :012) verdict missing-folder ;;
    :013) verdict unsafe-storage ;;
    *) exit 1 ;; # A read race or failed inspection isn't a verified CAS loss.
  esac
}
compare

# The identity used to derive this key was just verified by inspect(). Resolve home by the
# same account lookup, not by caller-supplied paths or the ambient environment.
account_home() {
  account_path=$(getent passwd "$uid" 2>/dev/null | cut -d: -f6)
  if [ -z "$account_path" ]; then account_path=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd); fi
  case "$account_path" in /*) printf '%s' "$account_path" ;; *) return 1 ;; esac
}
home=$(account_home) || verdict unsafe-storage
key=$(printf 'machine-v1:%s\n%s\n%s' "$host" "$uid" "$rsha" | sha256sum | cut -d' ' -f1)
[ "${#key}" -eq 64 ] || exit 1
storage="$home/.bigbud/workspace-modes/$key"
enter_private_dir() {
  name=$1; shift
  test ! -L "$name" || verdict unsafe-storage
  test -e "$name" || mkdir -m 700 -- "$name" 2>/dev/null || :
  test -n "$(find "$name" -maxdepth 0 -type d -uid "$uid" "$@" -printf x)" || verdict unsafe-storage
  cd -P -- "$name" || verdict unsafe-storage
}
cd -P -- "$home" || verdict unsafe-storage
test -n "$(find . -maxdepth 0 -type d ! -perm /022 -printf x)" || verdict unsafe-storage
enter_private_dir ./.bigbud '!' -perm /022
enter_private_dir ./workspace-modes -perm 700
enter_private_dir "./$key" -perm 700

# Stay anchored in that directory and recheck the exact observation at the publication boundary.
# Generation files are immutable under the store contract. All writers claim a generation with
# an exclusive hard link, so an advance after this check is still fenced by the same target.
tmp=$(mktemp ./.tmp.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
printf '%s' "$next" >"$tmp"
sync -- "$tmp"
compare
test "$(account_home)" = "$home" && test "$storage" -ef . || verdict scope-changed
target=./$((generation + 1)).json
if ! ln -T -- "$tmp" "$target" 2>/dev/null; then
  # A distinct, valid winner is the only confirmed link collision. Do not infer failure from
  # a generic ln error (or when our own inode is visible but durability is unknown).
  if [ -f "$target" ] && [ ! -L "$target" ] && [ ! "$tmp" -ef "$target" ]; then
    observe
    status=$(printf '%s' "$actual" | base64 -d | tail -c 4)
    if [ "$status" = :000 ] && [ "$actual" != "$expected" ]; then changed; fi
  fi
  exit 1
fi
# Persist the new link and any new directories before acknowledging; any failure from here
# until the receipt must be uncertain. Do not undo or replay a potentially committed link.
sync -- . .. ../.. ../../..
test "$storage" -ef . || exit 1
for file in ./*.json; do
  n=${file##*/}; n=${n%.json}
  case "$n" in ''|0*|*[!0-9]*) continue ;; esac
  if [ "${#n}" -le 16 ] && [ "$n" -lt "$generation" ]; then
    # After the durable write, pruning is best-effort, never part of the receipt.
    rm -f -- "$file" 2>/dev/null || :
  fi
done
verdict committed
