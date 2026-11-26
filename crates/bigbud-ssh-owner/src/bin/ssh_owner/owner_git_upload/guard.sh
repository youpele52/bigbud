# Runs on the target under `env -i`. Both operands were validated by the owner
# as exact absolute paths; this re-checks containment after resolving symlinks.
root=$1 repo=$2
r=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 125
p=$(cd -P -- "$repo" 2>/dev/null && pwd -P) || exit 125
[ "$r" != / ] || exit 126
case $p in "$r" | "$r"/*) ;; *) exit 126 ;; esac
exec git-upload-pack --timeout=60 "$p"
