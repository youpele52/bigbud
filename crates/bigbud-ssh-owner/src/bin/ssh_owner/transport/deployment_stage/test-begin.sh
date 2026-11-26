# Run in a disposable, unprivileged Linux fixture only: /bin/sh test-begin.sh /absolute/path/to/begin.sh
set -eu
[ "$(uname -s)" = Linux ] && [ "$(id -u)" != 0 ] || exit 1
recipe=${1:?absolute path to begin.sh required}
case "$recipe" in /*) ;; *) exit 1 ;; esac
umask 077
container=$(mktemp -d /tmp/bigbud-picker-linux-XXXXXXXX)
owned_link=
cleanup() {
  if [ -n "$owned_link" ]; then unlink "$owned_link"; fi
  rm -rf -- "$container"
}
trap cleanup EXIT
root=$container/deployment-graphs
outside=$container/outside
id=2e789a0b-6e7b-411b-8d34-4107f1c18902
name=1.2.3-beta+test-x86_64-unknown-linux-musl-aaaaaaaaaaaaaaaa
archive=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
manifest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
stage=$root/.staging-$id
final=$root/$name
mkdir "$outside"
printf 'untouched\n' > "$outside/sentinel"

expect() {
  expected_code=$1 expected_out=$2
  shift 2
  code=0
  output=$(/bin/sh "$recipe" "$@") || code=$?
  if [ "$code" != "$expected_code" ] || [ "$output" != "$expected_out" ]; then
    printf 'expected %s / %s, got %s / %s\n' "$expected_code" "$expected_out" "$code" "$output" >&2
    exit 1
  fi
}
begin() { expect "$1" "$2" "$root" "$id" "$name" "$archive" "$manifest"; }

begin 70 '' # No automatic creation of a fixture root.
[ ! -e "$root" ]
expect 70 '' "$outside" "$id" "$name" "$archive" "$manifest"
ln -s "$outside" "$root"
begin 70 ''
unlink "$root"
ln -s "$container" "${container}link"
owned_link=${container}link
expect 70 '' "$owned_link/deployment-graphs" "$id" "$name" "$archive" "$manifest"
unlink "$owned_link"
owned_link=
mkdir "$root"
chmod 750 "$root"
begin 70 ''
chmod 700 "$root"
chmod 750 "$container"
begin 70 ''
chmod 700 "$container"
expect 64 '' "$root" "$id" '../outside' "$archive" "$manifest"
expect 64 '' "$root" '../outside' "$name" "$archive" "$manifest"

ln -s "$outside" "$final"
begin 73 ''
unlink "$final"
ln -s "$outside/missing" "$stage"
begin 73 ''
unlink "$stage"

begin 0 staged
[ "$(stat -c '%a' "$stage")" = 700 ]
[ -z "$(ls -A "$stage")" ]
[ ! -e "$final" ]
begin 73 '' # Existing empty stage is not adopted.
printf 'keep\n' > "$stage/sentinel"
begin 73 ''
[ "$(cat "$stage/sentinel")" = keep ]

# Existing final contents are inspected only through a standalone, exact receipt.
mkdir "$final"
begin 73 ''
ln -s "$outside/sentinel" "$final/complete"
begin 73 ''
unlink "$final/complete"
mkfifo "$final/complete"
begin 73 ''
unlink "$final/complete"
printf '%s %s\n' "$archive" "$archive" > "$final/complete"
begin 73 ''
printf '%s %s\n\000' "$archive" "$manifest" > "$final/complete"
begin 73 ''
printf '%s %s\n\n' "$archive" "$manifest" > "$final/complete"
begin 73 ''
printf '%s %s' "$archive" "$manifest" > "$final/complete"
begin 73 ''
printf '%s %s\n' "$archive" "$manifest" > "$final/complete"
ln "$final/complete" "$outside/receipt-link"
begin 73 ''
unlink "$outside/receipt-link"
begin 0 present
[ "$(cat "$stage/sentinel")" = keep ]
[ "$(cat "$outside/sentinel")" = untouched ]
[ "$(ls -A "$outside")" = sentinel ]
printf 'synthetic Linux deployment begin checks passed\n'
