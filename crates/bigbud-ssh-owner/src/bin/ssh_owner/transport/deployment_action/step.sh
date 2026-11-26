set -eu
umask 077
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
unset CDPATH

# One bounded deployment step inside the disposable Linux picker fixture. Every
# operand is rechecked here after the owner has matched approval and validated
# ASCII operands. No account-home lookup, no recursive cleanup, no repair.
#
# Usage: step.sh <graphs-root> <op> <request-id> <extra...>
#   archive-upload <sha256> <size>      bytes on stdin
#   reset <install-name>
#   fetch <sha256> <url> <max-bytes>
#   publish <install-name> <archive-sha256> <manifest-sha256> <node> <entry> <path:sha256>...
#   start <install-name> <node> <entry> <authority-id> <enable-boot>
[ "$#" -ge 3 ] || exit 64
graphs=$1
op=$2
request=$3
shift 3
case "$graphs" in /tmp/bigbud-picker-linux-*/deployment-graphs) ;; *) exit 70 ;; esac
container=${graphs%/deployment-graphs}
suffix=${container#/tmp/bigbud-picker-linux-}
case "$suffix" in ''|*[!a-zA-Z0-9]*) exit 70 ;; esac
[ "${#suffix}" -le 64 ] || exit 70

case "$request" in ????????-????-4???-[89ab]???-????????????) ;; *) exit 64 ;; esac
case "$request" in *[!a-f0-9-]*) exit 64 ;; esac
[ "$(printf '%s' "$request" | tr -d '-' | wc -c)" -eq 32 ] || exit 64

digest() {
  case "$1" in ''|*[!a-f0-9]*) exit 64 ;; esac
  [ "${#1}" -eq 64 ] || exit 64
}
install_name() {
  case "$1" in [a-zA-Z0-9]*) ;; *) exit 64 ;; esac
  case "$1" in *[!a-zA-Z0-9._+-]*) exit 64 ;; esac
  [ "${#1}" -le 128 ] || exit 64
}
graph_path() {
  case "$1" in ''|/*|*..*) exit 64 ;; esac
  case "$1" in *[!a-zA-Z0-9._+/-]*) exit 64 ;; esac
}
sha_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }

[ "$(uname -s)" = Linux ] || exit 70
uid=$(id -u) || exit 70
[ "$uid" != 0 ] || exit 70
private_cd() {
  [ ! -L "$1" ] && [ -d "$1" ] && cd -P "$1" &&
    [ "$(pwd -P)" = "$2" ] && [ "$(stat -c '%u:%a' .)" = "$uid:700" ]
}
[ ! -L /tmp ] && cd -P /tmp && [ "$(pwd -P)" = /tmp ] || exit 70
private_cd "./${container##*/}" "$container" || exit 70
private_cd ./deployment-graphs "$graphs" || exit 70
stage=./.staging-$request

case "$op" in
  archive-upload)
    [ "$#" -eq 2 ] || exit 64
    digest "$1"
    case "$2" in ''|0*|*[!0-9]*) exit 64 ;; esac
    [ "${#2}" -le 5 ] && [ "$2" -ge 1 ] && [ "$2" -le 49152 ] || exit 64
    private_cd "$stage" "$graphs/.staging-$request" || exit 73
    archive=./archive.part
    [ ! -e "$archive" ] && [ ! -L "$archive" ] || exit 73
    temp=$(mktemp ./.archive-upload.XXXXXXXX) || exit 74
    trap 'rm -f -- "$temp"' 0
    trap 'exit 75' HUP INT TERM
    head -c "$(($2 + 1))" > "$temp" || exit 74
    [ "$(wc -c < "$temp")" -eq "$2" ] || exit 65
    [ "$(sha_of "$temp")" = "$1" ] || exit 65
    ln -T -- "$temp" "$archive" || { [ -e "$archive" ] && exit 73; exit 75; }
    rm -- "$temp" || exit 75
    trap - 0
    printf 'archive-stored\n'
    ;;
  reset)
    [ "$#" -eq 1 ] || exit 64
    install_name "$1"
    # Never remove a published install; only this request's staging directory.
    [ ! -L "$stage" ] && [ -d "$stage" ] || exit 73
    private_cd "$stage" "$graphs/.staging-$request" || exit 73
    cd -P .. || exit 74
    rm -rf -- "$stage" || exit 74
    printf 'reset\n'
    ;;
  fetch)
    [ "$#" -eq 3 ] || exit 64
    digest "$1"
    case "$2" in https://*) ;; *) exit 64 ;; esac
    case "$2" in *[\'\"\\\`\<\>\|\;\&\$\ ]*) exit 64 ;; esac
    [ "${#2}" -le 2048 ] || exit 64
    case "$3" in ''|0*|*[!0-9]*) exit 64 ;; esac
    [ "${#3}" -le 10 ] || exit 64
    private_cd "$stage" "$graphs/.staging-$request" || exit 73
    archive=./archive.part
    [ ! -e "$archive" ] && [ ! -L "$archive" ] || exit 73
    # A transport or curl failure is a distinct exit so the owner never reads it
    # as a change that did not happen.
    curl -fsS --proto =https --proto-redir =https --max-redirs 5 \
      --connect-timeout 20 --max-filesize "$3" -L -o "$archive" "$2" || exit 75
    [ "$(sha_of "$archive")" = "$1" ] || { rm -f -- "$archive"; exit 65; }
    printf 'fetched\n'
    ;;
  publish)
    [ "$#" -ge 6 ] || exit 64
    install_name "$1"
    digest "$2"
    digest "$3"
    graph_path "$4"
    graph_path "$5"
    final=./$1
    archive=$2
    manifest=$3
    node=$4
    entry=$5
    shift 5
    private_cd "$stage" "$graphs/.staging-$request" || exit 73
    [ ! -L "$final" ] || exit 73
    [ ! -e "$final" ] || exit 73
    [ -f ./archive.part ] && [ ! -L ./archive.part ] || exit 73
    [ -f ./manifest.json ] && [ ! -L ./manifest.json ] || exit 73
    [ "$(sha_of ./archive.part)" = "$archive" ] || exit 65
    [ "$(sha_of ./manifest.json)" = "$manifest" ] || exit 65
    [ ! -e ./graph ] && [ ! -L ./graph ] || exit 73
    mkdir -m 700 ./graph || exit 74
    tar -xzf ./archive.part -C ./graph --no-same-owner || { rm -rf -- ./graph; exit 66; }
    for pair in "$@"; do
      member=${pair%%:*}
      want=${pair##*:}
      graph_path "$member"
      digest "$want"
      target=./graph/$member
      [ -f "$target" ] && [ ! -L "$target" ] || { rm -rf -- ./graph; exit 65; }
      [ "$(sha_of "$target")" = "$want" ] || { rm -rf -- ./graph; exit 65; }
    done
    [ -f "./graph/$node" ] && [ -f "./graph/$entry" ] || { rm -rf -- ./graph; exit 65; }
    rm -f -- ./archive.part || exit 74
    printf '%s %s\n' "$archive" "$manifest" > ./complete || exit 74
    sync -f . 2>/dev/null || sync
    cd -P .. || exit 74
    [ ! -e "$final" ] && [ ! -L "$final" ] || exit 73
    mv -- "$stage" "$final" || exit 74
    sync -f . 2>/dev/null || sync
    printf 'published\n'
    ;;
  start)
    [ "$#" -eq 5 ] || exit 64
    install_name "$1"
    graph_path "$2"
    graph_path "$3"
    case "$4" in ''|*[!a-f0-9]*) exit 64 ;; esac
    [ "${#4}" -eq 32 ] || exit 64
    case "$5" in 0|1) ;; *) exit 64 ;; esac
    install=./$1
    private_cd "$install" "$graphs/$1" || exit 73
    private_cd ./graph "$graphs/$1/graph" || exit 73
    [ -f "$2" ] && [ ! -L "$2" ] || exit 70
    [ -f "$3" ] && [ ! -L "$3" ] || exit 70
    if [ "$5" = 1 ]; then
      exec "./$2" "./$3" backend enable --authority "$4" --confirm-startup
    fi
    exec "./$2" "./$3" backend start --authority "$4"
    ;;
  *) exit 64 ;;
esac
