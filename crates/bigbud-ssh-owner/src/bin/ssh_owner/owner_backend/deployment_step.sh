set -eu
umask 077
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
unset CDPATH

# W2 T-backend production deployment step, compiled into the SSH owner. The
# owner validates every operand before dispatch; this recipe rechecks them and
# keeps the legacy remote layout byte for byte:
#   ~/.bigbud/backend-graphs/<install>            immutable published install
#   ~/.bigbud/backend-graphs/.staging-<request>   request-scoped staging
#   ~/.bigbud/backend-setup/<request>/<name>      setup inputs, outside the graph
# Exit codes keep the legacy meaning: 64 usage, 65 hash or size mismatch,
# 66 unusable archive, 70 unsupported account, 73 conflicting install,
# 75 download unavailable (the caller may fall back to an upload).
#
# Usage: <op> <expected-home|-> <operands...>

[ "$#" -ge 2 ] || exit 64
op=$1
want_home=$2
shift 2
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
# Probe and completion reads report or ignore the home. Setup and start name
# the home their absolute paths came from; staging steps may name it.
case "$op:$want_home" in
  probe:-|read-completion:-) ;;
  probe:*|read-completion:*|setup:-|start:-) exit 64 ;;
  *:-) ;;
  *) [ "$home" = "$want_home" ] || exit 70 ;;
esac
base="$home/.bigbud/backend-graphs"

request() {
  case "$1" in ????????-????-4???-[89ab]???-????????????) ;; *) exit 64 ;; esac
  case "$1" in *[!a-f0-9-]*) exit 64 ;; esac
}
digest() {
  case "$1" in ''|*[!a-f0-9]*) exit 64 ;; esac
  [ "${#1}" -eq 64 ] || exit 64
}
authority() {
  case "$1" in ''|*[!a-f0-9]*) exit 64 ;; esac
  [ "${#1}" -eq 32 ] || exit 64
}
install_name() {
  case "$1" in [a-zA-Z0-9]*) ;; *) exit 64 ;; esac
  case "$1" in *[!a-zA-Z0-9._+-]*) exit 64 ;; esac
  [ "${#1}" -le 128 ] || exit 64
}
graph_path() {
  case "$1" in ''|/*|*..*|*//*) exit 64 ;; esac
  case "$1" in *[!a-zA-Z0-9._+/-]*) exit 64 ;; esac
}
size() {
  case "$1" in ''|0*|*[!0-9]*) exit 64 ;; esac
  [ "${#1}" -le 10 ] || exit 64
}
sha_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }
# Exactly <size> bytes from stdin into <file>, or a 65 size refusal.
take() {
  head -c "$(($2 + 1))" > "$1" || return 74
  [ "$(wc -c < "$1")" -eq "$2" ] || { rm -f -- "$1"; return 65; }
}
staging() {
  [ -d "$1" ] && [ ! -L "$1" ] || exit 73
}

case "$op" in
probe)
  [ "$#" -eq 1 ] || exit 64
  request "$1"
  printf 'home=%s\n' "$home"
  printf 'arch=%s\n' "$(uname -m)"
  for key in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    if [ -r "$key" ]; then printf 'host=%s\n' "$(cut -d ' ' -f 1,2 "$key" | sha256sum | cut -d ' ' -f 1)"; break; fi
  done
  for done_file in "$home"/.bigbud/backend-services/*/setup-complete-v1; do
    [ -f "$done_file" ] || continue
    if grep -q "\"requestId\":\"$1\"" "$done_file"; then printf 'completed=%s\n' "$(basename "$(dirname "$done_file")")"; fi
  done
  ;;
begin)
  [ "$#" -eq 4 ] || exit 64
  request "$1"; install_name "$2"; digest "$3"; digest "$4"
  final="$base/$2"
  stage="$base/.staging-$1"
  mkdir -p "$home/.bigbud" "$base"; chmod 700 "$base"
  if [ -f "$final/complete" ] && [ "$(cat "$final/complete")" = "$3 $4" ]; then echo present; exit 0; fi
  if [ -e "$final" ] || [ -L "$final" ]; then exit 73; fi
  rm -rf -- "$stage"; mkdir -- "$stage"; echo staged
  ;;
put-manifest)
  [ "$#" -eq 3 ] || exit 64
  request "$1"; digest "$2"; size "$3"
  stage="$base/.staging-$1"
  staging "$stage"
  take "$stage/manifest.json.part" "$3" || { rm -rf -- "$stage"; exit 65; }
  if [ "$(sha_of "$stage/manifest.json.part")" != "$2" ]; then rm -rf -- "$stage"; exit 65; fi
  mv -- "$stage/manifest.json.part" "$stage/manifest.json"
  ;;
put-input)
  [ "$#" -eq 4 ] || exit 64
  request "$1"; digest "$3"; size "$4"
  case "$2" in rust-manifest.json|trusted-keys.json) ;; *) exit 64 ;; esac
  dir="$home/.bigbud/backend-setup/$1"; mkdir -p "$dir"; chmod 700 "$home/.bigbud/backend-setup" "$dir"
  take "$dir/$2.part" "$4" || exit 65
  if [ "$(sha_of "$dir/$2.part")" != "$3" ]; then rm -f -- "$dir/$2.part"; exit 65; fi
  mv -- "$dir/$2.part" "$dir/$2"; printf 'path=%s\n' "$dir/$2"
  ;;
fetch-url)
  [ "$#" -eq 4 ] || exit 64
  request "$1"; digest "$2"; size "$4"
  case "$3" in https://*) ;; *) exit 64 ;; esac
  case "$3" in *[\'\"\\\`\<\>\|\;\&\$\ ]*) exit 64 ;; esac
  stage="$base/.staging-$1"
  staging "$stage"
  curl -fsS --proto =https --proto-redir =https --max-redirs 5 --connect-timeout 20 --max-filesize "$4" -L -o "$stage/archive.part" "$3" || exit 75
  if [ "$(sha_of "$stage/archive.part")" != "$2" ]; then rm -rf -- "$stage"; exit 65; fi
  ;;
fetch-stdin)
  [ "$#" -eq 3 ] || exit 64
  request "$1"; digest "$2"; size "$3"
  stage="$base/.staging-$1"
  staging "$stage"
  take "$stage/archive.part" "$3" || { rm -rf -- "$stage"; exit 65; }
  if [ "$(sha_of "$stage/archive.part")" != "$2" ]; then rm -rf -- "$stage"; exit 65; fi
  ;;
commit)
  [ "$#" -eq 10 ] || exit 64
  request "$1"; install_name "$2"; digest "$3"; digest "$4"
  graph_path "$5"; digest "$6"; graph_path "$7"; digest "$8"; graph_path "$9"; digest "${10}"
  final="$base/$2"
  stage="$base/.staging-$1"
  staging "$stage"
  if [ "$(sha_of "$stage/archive.part")" != "$3" ] || [ "$(sha_of "$stage/manifest.json")" != "$4" ]; then rm -rf -- "$stage"; exit 65; fi
  mkdir -- "$stage/graph"
  tar -xzf "$stage/archive.part" -C "$stage/graph" --no-same-owner || { rm -rf -- "$stage"; exit 66; }
  rm -f -- "$stage/archive.part"
  for pair in "$5:$6" "$7:$8" "$9:${10}"; do
    member="$stage/graph/${pair%%:*}"
    if [ ! -f "$member" ] || [ -L "$member" ] || [ "$(sha_of "$member")" != "${pair##*:}" ]; then rm -rf -- "$stage"; exit 65; fi
  done
  printf '%s %s\n' "$3" "$4" > "$stage/complete"
  if [ -e "$final" ] || [ -L "$final" ]; then rm -rf -- "$stage"; exit 73; fi
  mv -- "$stage" "$final"
  ;;
setup)
  [ "$#" -eq 4 ] || exit 64
  request "$1"; install_name "$2"; graph_path "$3"; graph_path "$4"
  graph="$base/$2/graph"
  inputs="$home/.bigbud/backend-setup/$1"
  [ -f "$graph/$3" ] && [ ! -L "$graph/$3" ] && [ -f "$graph/$4" ] && [ ! -L "$graph/$4" ] || exit 70
  [ -f "$inputs/rust-manifest.json" ] && [ -f "$inputs/trusted-keys.json" ] || exit 73
  exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME="$home" LANG=C.UTF-8 \
    "$graph/$3" "$graph/$4" backend setup --graph-root "$graph" \
    --graph-manifest "$base/$2/manifest.json" --rust-manifest "$inputs/rust-manifest.json" \
    --trusted-keys "$inputs/trusted-keys.json" --backend-home "$home/.bigbud/backend" \
    --request-id "$1" --confirm-fresh-setup
  ;;
start)
  [ "$#" -eq 5 ] || exit 64
  install_name "$1"; graph_path "$2"; graph_path "$3"; authority "$4"
  graph="$base/$1/graph"
  [ -f "$graph/$2" ] && [ ! -L "$graph/$2" ] && [ -f "$graph/$3" ] && [ ! -L "$graph/$3" ] || exit 70
  case "$5" in
    1) exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME="$home" LANG=C.UTF-8 \
         "$graph/$2" "$graph/$3" backend enable --authority "$4" --confirm-startup ;;
    0) exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME="$home" LANG=C.UTF-8 \
         "$graph/$2" "$graph/$3" backend start --authority "$4" ;;
    *) exit 64 ;;
  esac
  ;;
read-completion)
  [ "$#" -eq 1 ] || exit 64
  authority "$1"
  exec head -c 16384 "$home/.bigbud/backend-services/$1/setup-complete-v1"
  ;;
reset)
  [ "$#" -eq 1 ] || exit 64
  request "$1"
  # Only this request's staging directory, never a published install.
  rm -rf -- "$base/.staging-$1"
  printf 'reset\n'
  ;;
*) exit 64 ;;
esac
