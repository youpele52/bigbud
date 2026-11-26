#!/bin/sh
# Run only in an isolated Linux fixture, with a disposable account home.
set -eu
umask 077
recipe=$1
test -f /.dockerenv
test ! -e /etc/machine-id && test ! -L /etc/machine-id
test ! -e /var/lib/dbus/machine-id && test ! -L /var/lib/dbus/machine-id
uid=$(id -u)
home=$(getent passwd "$uid" | cut -d: -f6)
test ! -e "$home/.bigbud" && test ! -L "$home/.bigbud"
test ! -e /fixture-workspace
test ! -e /fixture-alias
root="/fixture-workspace/a'b"
mkdir -p "$root"
ln -s "$root" /fixture-alias
run() { /bin/sh "$recipe" "$1"; }
status_is() {
  status=0
  run "$1" >/fixture-observed || status=$?
  test "$status" -eq "$2"
  test ! -s /fixture-observed
}
status_is /fixture-alias 11
raw=0123456789abcdef0123456789abcdef
printf '%s\n' "$raw" >/etc/machine-id
host=$(printf 'bigbud.machine-identity.v1\000%s' "$raw" | sha256sum | cut -d' ' -f1)
rsha=$(printf '%s' "$root" | sha256sum | cut -d' ' -f1)
key=$(printf 'machine-v1:%s\n%s\n%s' "$host" "$uid" "$rsha" | sha256sum | cut -d' ' -f1)
dir="$home/.bigbud/workspace-modes/$key"
expected() { printf 'bigbud.workspace-mode.inspect.v1 %s %s %s %s\n%s\n' "$host" "$uid" "$rsha" "$1" "$root"; }

run /fixture-alias >/fixture-observed
expected 0 >/fixture-expected
cmp /fixture-expected /fixture-observed
test ! -e "$home/.bigbud"
status_is /fixture-nonexistent 12

mkdir -m 700 -p "$dir"
chmod 755 "$dir"
status_is /fixture-alias 13
chmod 700 "$dir"
raw_record=$(printf '{"format":"bigbud.workspace-mode.v1","generation":2,"hostIdentity":"machine-v1:%s","accountUid":%s,"realpathSha256":"%s","mode":"remote-runtime","owner":null}' "$host" "$uid" "$rsha")
printf 'previous' >"$dir/1.json"
printf '%s' "$raw_record" >"$dir/2.json"
printf 'ignored' >"$dir/03.json"
run /fixture-alias >/fixture-observed
{ expected 2; printf '%s' "$raw_record"; } >/fixture-expected
cmp /fixture-expected /fixture-observed
test "$(stat -c '%a' "$dir/2.json")" = 600
test "$(cat "$dir/2.json")" = "$raw_record"

ln -s 2.json "$dir/3.json"
status_is /fixture-alias 13
rm "$dir/3.json"
: >"$dir/3.json"
status_is /fixture-alias 14
dd if=/dev/zero of="$dir/3.json" bs=1025 count=1 status=none
status_is /fixture-alias 13
rm "$dir/3.json"
mv "$dir" "$dir-away"
ln -s "$dir-away" "$dir"
status_is /fixture-alias 13
printf '%s\n' 'workspace mode recipe fixture passed'
