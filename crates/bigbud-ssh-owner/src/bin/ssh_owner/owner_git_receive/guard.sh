# Runs on the target under `env -i`. Both operands were validated by the owner
# as exact absolute paths; this re-checks containment after resolving symlinks.
# Fast-forward-only and no deletion are forced over the repository's config.
root=$1 repo=$2
r=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 125
p=$(cd -P -- "$repo" 2>/dev/null && pwd -P) || exit 125
[ "$r" != / ] || exit 126
case $p in "$r" | "$r"/*) ;; *) exit 126 ;; esac
export GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0=receive.denyNonFastForwards GIT_CONFIG_VALUE_0=true \
    GIT_CONFIG_KEY_1=receive.denyDeletes GIT_CONFIG_VALUE_1=true
exec git-receive-pack "$p"
