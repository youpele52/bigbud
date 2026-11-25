set -eu
umask 077
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
unset CDPATH

# Only the isolated Linux picker can supply this path. No account-home lookup,
# mkdir -p, chmod, reset, or cleanup. The fixture excludes concurrent changes
# by untrusted same-UID processes; these shell checks are not race-proof there.
[ "$#" -eq 5 ] || exit 64
case "$1" in /tmp/bigbud-picker-linux-*/deployment-graphs) ;; *) exit 70 ;; esac
container=${1%/deployment-graphs}
suffix=${container#/tmp/bigbud-picker-linux-}
case "$suffix" in ''|*[!a-zA-Z0-9]*) exit 70 ;; esac
[ "${#suffix}" -le 64 ] || exit 70

# Native code has already matched approval and validated exact UUID, target,
# version, and hashes. Independently refuse unsafe filesystem components here.
case "$2" in ''|*[!a-f0-9-]*) exit 64 ;; esac
case "$3" in [a-zA-Z0-9]*) ;; *) exit 64 ;; esac
case "$3" in *[!a-zA-Z0-9._+-]*) exit 64 ;; esac
for digest in "$4" "$5"; do
  case "$digest" in ''|*[!a-f0-9]*) exit 64 ;; esac
  [ "${#digest}" -eq 64 ] || exit 64
done

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

stage=./.staging-$2
final=./$3
[ ! -L "$stage" ] && [ ! -L "$final" ] || exit 73
if [ -e "$final" ]; then
  # An exact receipt is an observation, not proof the graph files are intact.
  # cmp reads only the expected input and detects any extra bytes (even NUL/LF).
  (
    [ -d "$final" ] && cd -P "$final" && [ "$(pwd -P)" = "$1/$3" ] &&
      [ ! -L ./complete ] && [ -f ./complete ] &&
      [ "$(stat -c '%u:%h' ./complete)" = "$uid:1" ] &&
      printf '%s %s\n' "$4" "$5" | cmp -s ./complete -
  ) || exit 73
  printf 'present\n'
  exit
fi

# Even an empty existing stage could be the result of an interrupted begin.
# mkdir is exclusive; never repair, remove, or adopt someone else's stage.
[ ! -e "$stage" ] || exit 73
if ! mkdir -m 700 "$stage"; then
  [ ! -e "$stage" ] && [ ! -L "$stage" ] || exit 73
  exit 70
fi
printf 'staged\n'
