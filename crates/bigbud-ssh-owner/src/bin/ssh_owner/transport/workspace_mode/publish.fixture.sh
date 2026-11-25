#!/bin/sh
# Run only inside a network-disabled disposable Linux container, with a fresh account home.
set -eu
umask 077
recipes=$1
[ -f /.dockerenv ]
uid=$(id -u)
home=$(getent passwd "$uid" | cut -d: -f6)
[ ! -e "$home/.bigbud" ] && [ ! -L "$home/.bigbud" ]
[ ! -e /fixture-mode ] && [ ! -L /fixture-mode ]
raw=0123456789abcdef0123456789abcdef
printf '%s\n' "$raw" >/etc/machine-id
host=$(printf 'bigbud.machine-identity.v1\000%s' "$raw" | sha256sum | cut -d' ' -f1)
root="/fixture-mode/work space's"
alias=/fixture-mode/alias
mkdir -p "$root" /fixture-mode/other
ln -s "$root" "$alias"
rsha=$(printf '%s' "$root" | sha256sum | cut -d' ' -f1)
key=$(printf 'machine-v1:%s\n%s\n%s' "$host" "$uid" "$rsha" | sha256sum | cut -d' ' -f1)
dir="$home/.bigbud/workspace-modes/$key"
marker=bigbud.workspace-mode.publish.v1
owner_a='"backend-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
owner_b='"backend-v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
record() {
  printf '{"format":"bigbud.workspace-mode.v1","generation":%s,"hostIdentity":"machine-v1:%s","accountUid":%s,"realpathSha256":"%s","mode":"laptop-runtime","owner":%s}' \
    "$1" "$host" "$uid" "$rsha" "$2"
}
{ printf 'inspect() {\n'; /bin/cat "$recipes/inspect.sh"; printf '\n}\n'; /bin/cat "$recipes/publish.sh"; } >/fixture-mode/recipe
run() { /bin/sh /fixture-mode/recipe "$alias" "$root" "$host" "$uid" "$rsha" "$@"; }
verify_compare() {
  {
    printf '%s compare\n' "$marker"
    /bin/sh "$recipes/inspect.sh" "$alias"
    printf '\n%s end\n' "$marker"
  } >/fixture-mode/expected
  cmp /fixture-mode/expected "$1"
}

claim=$(record 1 "$owner_a")
rm "$alias"
[ "$(run 0 '' "$claim")" = "$marker missing-folder" ]
ln -s /fixture-mode/other "$alias"
run 0 '' "$claim" >/fixture-mode/retarget
verify_compare /fixture-mode/retarget
[ ! -e "$home/.bigbud" ]
rm "$alias"
ln -s "$root" "$alias"

[ "$(run 0 '' "$claim")" = "$marker committed" ]
[ "$(stat -c %a "$dir/1.json")" = 600 ]
[ "$(stat -c %a "$dir")" = 700 ]
[ "$(stat -c %a "$dir/..")" = 700 ]
printf '%s' "$claim" >/fixture-mode/exact
cmp /fixture-mode/exact "$dir/1.json"
run 0 '' "$claim" >/fixture-mode/stale
verify_compare /fixture-mode/stale
[ ! -e "$dir/2.json" ]

# Same generation but altered bytes (including a NUL invisible to shell command substitution).
previous=$(record 2 null)
next=$(record 3 "$owner_a")
for corruption in '\000' '\n'; do
  printf '%s' "$previous" >"$dir/2.json"
  printf '%b' "$corruption" >>"$dir/2.json"
  run 2 "$previous" "$next" >/fixture-mode/corrupt
  verify_compare /fixture-mode/corrupt
  [ ! -e "$dir/3.json" ]
done
rm "$dir/2.json"
ln -s 1.json "$dir/2.json"
[ "$(run 2 "$previous" "$next")" = "$marker unsafe-storage" ]
rm "$dir/2.json"
mkdir "$dir/2.json"
[ "$(run 1 "$claim" "$previous")" = "$marker unsafe-storage" ]
rmdir "$dir/2.json"
printf '%s' "$previous" >"$dir/2.json"

# Both peers reach the exclusive link before either is allowed to publish. This exercises
# the link-collision path, not just the earlier generation mismatch check.
{
  printf '%s\n' 'ln() {
    : >"/fixture-mode/link-$peer"
    attempts=0
    until [ -e /fixture-mode/link-a ] && [ -e /fixture-mode/link-b ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 500 ] || return 1
      sleep 0.01
    done
    command ln "$@"
  }'
  /bin/cat /fixture-mode/recipe
} >/fixture-mode/race-recipe
race() {
  peer=$1 /bin/sh /fixture-mode/race-recipe "$alias" "$root" "$host" "$uid" "$rsha" 2 "$previous" "$2"
}
race a "$next" >/fixture-mode/race-a &
a=$!
race b "$(record 3 "$owner_b")" >/fixture-mode/race-b &
b=$!
wait "$a"
wait "$b"
if [ "$(/bin/cat /fixture-mode/race-a)" = "$marker committed" ]; then
  verify_compare /fixture-mode/race-b
  [ "$(/bin/cat "$dir/3.json")" = "$next" ]
else
  [ "$(/bin/cat /fixture-mode/race-b)" = "$marker committed" ]
  verify_compare /fixture-mode/race-a
  [ "$(/bin/cat "$dir/3.json")" = "$(record 3 "$owner_b")" ]
fi
[ ! -e "$dir/1.json" ] && [ -f "$dir/2.json" ]

# Fail the durability command after the link; no durable receipt may escape and no rollback.
{ printf 'sync() { if [ "$2" = . ]; then return 1; fi; command sync "$@"; }\n'; /bin/cat /fixture-mode/recipe; } >/fixture-mode/broken-sync
previous=$(record 4 null)
next=$(record 5 "$owner_a")
printf '%s' "$previous" >"$dir/4.json"
if /bin/sh /fixture-mode/broken-sync "$alias" "$root" "$host" "$uid" "$rsha" 4 "$previous" "$next" >/fixture-mode/no-receipt; then
  exit 1
fi
[ ! -s /fixture-mode/no-receipt ]
[ "$(/bin/cat "$dir/5.json")" = "$next" ]
[ -f "$dir/4.json" ] && [ -f "$dir/3.json" ]
set -- "$dir"/.tmp.*
[ "$#" -eq 1 ] && [ ! -e "$1" ]
printf '%s\n' 'workspace mode publication recipe fixture passed'
