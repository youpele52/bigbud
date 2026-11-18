/**
 * The account's systemd user bus, for `systemctl --user` from processes whose environment has no
 * bus variables (managed services run with a cleared environment; SSH `clean-posix` commands too).
 *
 * The preamble proves `/run/user/<uid>` and its `bus` socket are this account's own (not
 * symlinks, mode 0700, owned by the uid), then exports `XDG_RUNTIME_DIR` and
 * `DBUS_SESSION_BUS_ADDRESS`. It fails (`set -eu`) before any systemctl call when they are not.
 */
export const USER_SYSTEMD_BUS_PREAMBLE = `set -eu
uid=$(id -u)
runtime="/run/user/$uid"
test ! -L "$runtime"; test -d "$runtime"
test "$(readlink -f -- "$runtime")" = "$runtime"
test "$(stat -c '%u' -- "$runtime")" = "$uid"
test "$(stat -c '%a' -- "$runtime")" = 700
test ! -L "$runtime/bus"; test -S "$runtime/bus"
test "$(stat -c '%u' -- "$runtime/bus")" = "$uid"
export XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" SYSTEMD_COLORS=0
`;

/** Fixed `systemctl --user` prefix; callers append validated arguments only. */
export const USER_SYSTEMCTL = "/usr/bin/systemctl --user --no-pager --no-ask-password";
