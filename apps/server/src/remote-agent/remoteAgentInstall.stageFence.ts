function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertReservationId(value: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value))
    throw new Error("Invalid remote agent staging reservation.");
}

/**
 * Acquire the same lock held by an upload command before fencing it. A live
 * command returns `live`; only an unlocked command can be durably revoked.
 */
export function buildRemoteAgentStageFenceRevokeCommand(
  root: string,
  reservationId: string,
): string {
  assertReservationId(reservationId);
  const quotedRoot = quote(root);
  return `set -eu
root=${quotedRoot}
staging_root="$root/staging"
test -d "$root" && test ! -L "$root"
if test ! -e "$staging_root"; then printf revoked; exit 0; fi
test -d "$staging_root" && test ! -L "$staging_root"
reservation_id=${quote(reservationId)}
reservation_lock="$staging_root/$reservation_id.lock"
reservation_fence="$staging_root/$reservation_id.fence"
if test ! -e "$reservation_lock"; then
  (set -C; umask 077; : > "$reservation_lock") 2>/dev/null || true
fi
test -f "$reservation_lock" && test ! -L "$reservation_lock"
test "$(stat -c '%u' "$reservation_lock")" = "$(id -u)"
test "$(stat -c '%a' "$reservation_lock")" = "600"
exec 8<> "$reservation_lock"
if ! flock -n -x 8; then printf live; exit 0; fi
temporary="$reservation_fence.$$.revoke"
if test -e "$reservation_fence" || test -L "$reservation_fence"; then
  test ! -L "$reservation_fence"
  test -f "$reservation_fence"
fi
printf revoked > "$temporary"
chmod 600 "$temporary"
mv -T "$temporary" "$reservation_fence"
sync -f "$staging_root"
printf revoked
`;
}
