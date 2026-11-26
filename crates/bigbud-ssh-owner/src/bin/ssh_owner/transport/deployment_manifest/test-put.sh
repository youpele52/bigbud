# On disposable unprivileged Linux: /bin/sh test-put.sh /absolute/path/to/put.sh
set -eu
[ "$(uname -s)" = Linux ] && [ "$(id -u)" != 0 ] || exit 1
recipe=${1:?absolute path to put.sh required}
case "$recipe" in /*) ;; *) exit 1 ;; esac
umask 077
container=$(mktemp -d /tmp/bigbud-picker-linux-XXXXXXXX)
trap 'rm -rf -- "$container"' 0
root=$container/deployment-graphs
outside=$container/outside
id=2e789a0b-6e7b-411b-8d34-4107f1c18902
stage=$root/.staging-$id
file=$stage/manifest.json
body=$container/body
printf '{"a":"b"}\n' > "$body"
size=$(wc -c < "$body")
digest=$(sha256sum < "$body")
digest=${digest%% *}
verify() {
  expected=$1 expected_out=$2 input=$3
  shift 3
  code=0
  output=$(/bin/sh "$recipe" "$@" < "$input") || code=$?
  [ "$code" -eq "$expected" ] && [ "$output" = "$expected_out" ] || {
    printf 'expected %s / %s, got %s / %s\n' "$expected" "$expected_out" "$code" "$output" >&2
    exit 1
  }
}
put() { verify "$1" "$2" "$body" "$root" "$id" "$digest" "$size"; }

mkdir "$outside"
printf 'keep\n' > "$outside/sentinel"
ln -s "$outside" "$root"
put 70 ''
unlink "$root"
mkdir "$root"
put 73 ''
[ ! -e "$stage" ]
ln -s "$outside" "$stage"
put 73 ''
unlink "$stage"
mkdir -m 750 "$stage"
put 73 ''
chmod 700 "$stage"
verify 64 '' "$body" "$root" "$id" "$digest" 49153
verify 64 '' "$body" "$root" "$id" "$digest" 0
verify 64 '' "$body" "$root" "$id" "$digest" "$size" arbitrary-name
verify 64 '' "$body" "$root" '../outside' "$digest" "$size"
verify 65 '' /dev/null "$root" "$id" "$digest" "$size"
verify 65 '' "$body" "$root" "$id" "$digest" "$((size - 1))"
verify 65 '' "$body" "$root" "$id" "$(printf '%064d' 0)" "$size"
[ -z "$(ls -A "$stage")" ]

ln -s "$outside/missing" "$file"
put 73 ''
[ ! -e "$outside/missing" ]
unlink "$file"
ln -s "$outside" "$file"
put 73 ''
[ ! -e "$outside/manifest.json" ]
unlink "$file"
mkdir "$file"
put 73 ''
[ -z "$(ls -A "$file")" ]
rmdir "$file"

# Launch two attempts against the same destination: exactly one can link it.
(/bin/sh "$recipe" "$root" "$id" "$digest" "$size" < "$body" > "$container/out1") &
first=$!
(/bin/sh "$recipe" "$root" "$id" "$digest" "$size" < "$body" > "$container/out2") &
second=$!
a=0 b=0
wait "$first" || a=$?
wait "$second" || b=$?
case "$a:$b" in 0:73|73:0) ;; *) exit 1 ;; esac
[ "$(wc -l < "$container/out1")" -eq "$((1 - a / 73))" ]
[ "$(wc -l < "$container/out2")" -eq "$((1 - b / 73))" ]
[ "$(cat "$container/out1" "$container/out2")" = manifest-stored ]
put 73 ''
cmp -s "$file" "$body"
[ "$(stat -c '%a:%h' "$file")" = '600:1' ]
[ "$(ls -A "$stage")" = manifest.json ]
[ "$(ls -A "$root")" = ".staging-$id" ]
[ "$(ls -A "$outside")" = sentinel ]
[ "$(cat "$outside/sentinel")" = keep ]
