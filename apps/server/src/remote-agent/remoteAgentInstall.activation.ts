import {
  buildRemoteAgentInstallPaths,
  buildRemoteAgentTrustedTargetValidator,
  type RemoteAgentBuildIdentity,
} from "./remoteAgentInstall.ts";

function buildActivationTransactionPrelude(identity: RemoteAgentBuildIdentity): string {
  const paths = buildRemoteAgentInstallPaths(identity);
  return `
set -eu
umask 077
bin_root=${paths.binRoot}
state_root=${paths.stateRoot}
candidate=${paths.installedBinary}
active=${paths.activeLink}
previous=${paths.previousLink}
lock="$state_root/activation.lock"
pending="$state_root/activation.pending"
pending_candidate="$pending/candidate"
pending_baseline="$pending/baseline"
bin_root_canonical=$(readlink -f -- "$bin_root")
candidate_canonical=$(readlink -f -- "$candidate")
${buildRemoteAgentTrustedTargetValidator()}
test -d "$state_root"
test ! -L "$state_root"
test "$(stat -c '%u' "$state_root")" = "$(id -u)"
test "$(stat -c '%a' "$state_root")" = "700"
if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
  (set -C; umask 077; : > "$lock") 2>/dev/null || true
fi
test -f "$lock"
test ! -L "$lock"
test "$(stat -c '%u' "$lock")" = "$(id -u)"
test "$(stat -c '%a' "$lock")" = "600"
exec 9<>"$lock"
flock -x -w 25 9
validate_link_slot() {
  slot=$1
  if { [ -e "$slot" ] || [ -L "$slot" ]; } && [ ! -L "$slot" ]; then return 1; fi
}
validate_pending() {
  test ! -L "$pending"
  test -d "$pending"
  test "$(stat -c '%u' "$pending")" = "$(id -u)"
  test "$(stat -c '%a' "$pending")" = "700"
  test -L "$pending_candidate"
  pending_candidate_target=$(validate_agent_target "$(readlink "$pending_candidate")")
  pending_baseline_target=
  if [ -e "$pending_baseline" ] || [ -L "$pending_baseline" ]; then
    test -L "$pending_baseline"
    pending_baseline_target=$(validate_agent_target "$(readlink "$pending_baseline")")
  fi
}
discard_pending() {
  cleanup="$state_root/.activation.completed.$$"
  test ! -e "$cleanup"
  test ! -L "$cleanup"
  mv -T "$pending" "$cleanup"
  rm -f "$cleanup/candidate" "$cleanup/baseline"
  rmdir "$cleanup"
}
recover_pending() {
  recovery_status=unchanged
  if [ ! -e "$pending" ] && [ ! -L "$pending" ]; then return 0; fi
  validate_pending
  if [ -n "\${expected_candidate:-}" ] && [ "$pending_candidate_target" != "$expected_candidate" ]; then
    return 1
  fi
  validate_link_slot "$active"
  validate_link_slot "$previous"
  if [ -L "$previous" ]; then
    validate_agent_target "$(readlink "$previous")" >/dev/null
  fi
  if [ -L "$active" ]; then
    active_target=$(validate_agent_target "$(readlink "$active")")
    if [ "$active_target" = "$pending_candidate_target" ]; then
      if [ -n "$pending_baseline_target" ]; then
        recovery_link="$active.$$.recovery.tmp"
        ln -s "$pending_baseline_target" "$recovery_link"
        mv -Tf "$recovery_link" "$active"
        recovery_status=restored
      else
        rm -f "$active"
        recovery_status=removed
      fi
    fi
  fi
  discard_pending
}
`;
}

export function buildRemoteAgentActivationScript(identity: RemoteAgentBuildIdentity): string {
  return `${buildActivationTransactionPrelude(identity)}
expected_candidate=
recover_pending
test -f "$candidate"
test ! -L "$candidate"
test "$(stat -c '%u' "$candidate")" = "$(id -u)"
test "$(stat -c '%a' "$candidate")" = "700"
candidate_canonical=$(validate_agent_target "$candidate")
validate_link_slot "$active"
validate_link_slot "$previous"
if [ -L "$active" ]; then
  current_target=$(validate_agent_target "$(readlink "$active")")
  if [ "$current_target" = "$candidate_canonical" ]; then
    printf 'unchanged\n'
    exit 0
  fi
fi
pending_temporary="$state_root/.activation.pending.$$"
test ! -e "$pending_temporary"
test ! -L "$pending_temporary"
mkdir -m 700 "$pending_temporary"
cleanup_pending_temporary() {
  if [ -d "$pending_temporary" ] && [ ! -L "$pending_temporary" ]; then
    rm -f "$pending_temporary/candidate" "$pending_temporary/baseline"
    rmdir "$pending_temporary"
  fi
}
trap cleanup_pending_temporary EXIT HUP INT TERM
ln -s "$candidate_canonical" "$pending_temporary/candidate"
if [ -L "$active" ]; then
  ln -s "$current_target" "$pending_temporary/baseline"
fi
mv -T "$pending_temporary" "$pending"
trap - EXIT HUP INT TERM
if [ -L "$active" ]; then
  previous_temporary="$previous.$$.activation.tmp"
  ln -s "$current_target" "$previous_temporary"
  mv -Tf "$previous_temporary" "$previous"
fi
active_temporary="$active.$$.activation.tmp"
ln -s "$candidate_canonical" "$active_temporary"
mv -Tf "$active_temporary" "$active"
printf 'activated\n'
`;
}

export function buildRemoteAgentActivationRecoveryScript(
  identity: RemoteAgentBuildIdentity,
): string {
  return `${buildActivationTransactionPrelude(identity)}
expected_candidate=$candidate_canonical
recover_pending
printf '%s\n' "$recovery_status"
`;
}

export function buildRemoteAgentActivationFailureRecoveryScript(
  identity: RemoteAgentBuildIdentity,
): string {
  return `${buildActivationTransactionPrelude(identity)}
expected_candidate=$candidate_canonical
recover_pending
if [ "$recovery_status" = unchanged ]; then
  validate_link_slot "$active"
  validate_link_slot "$previous"
  if [ -L "$active" ]; then
    active_target=$(validate_agent_target "$(readlink "$active")")
    if [ "$active_target" = "$candidate_canonical" ]; then
      if [ -L "$previous" ]; then
        previous_target=$(validate_agent_target "$(readlink "$previous")")
        test "$previous_target" != "$candidate_canonical"
        recovery_link="$active.$$.recovery.tmp"
        ln -s "$previous_target" "$recovery_link"
        mv -Tf "$recovery_link" "$active"
        recovery_status=restored
      else
        rm -f "$active"
        recovery_status=removed
      fi
    else
      recovery_status=baseline
    fi
  else
    recovery_status=baseline
  fi
fi
printf '%s\n' "$recovery_status"
`;
}

export function buildRemoteAgentActivationCommittedStateScript(
  identity: RemoteAgentBuildIdentity,
): string {
  return `${buildActivationTransactionPrelude(identity)}
if [ -e "$pending" ] || [ -L "$pending" ]; then
  validate_pending
  test "$pending_candidate_target" = "$candidate_canonical"
  printf 'pending\n'
  exit 0
fi
validate_link_slot "$active"
if [ -L "$active" ]; then
  active_target=$(validate_agent_target "$(readlink "$active")")
  if [ "$active_target" = "$candidate_canonical" ]; then
    printf 'active\n'
    exit 0
  fi
fi
printf 'baseline\n'
`;
}

export function buildRemoteAgentActivationFinalizeScript(
  identity: RemoteAgentBuildIdentity,
): string {
  return `${buildActivationTransactionPrelude(identity)}
if [ ! -e "$pending" ] && [ ! -L "$pending" ]; then
  printf 'unchanged\n'
  exit 0
fi
validate_pending
test "$pending_candidate_target" = "$candidate_canonical"
validate_link_slot "$active"
test -L "$active"
active_target=$(validate_agent_target "$(readlink "$active")")
test "$active_target" = "$candidate_canonical"
discard_pending
printf 'finalized\n'
`;
}

/** Compatibility alias for callers that still use rollback terminology. */
export const buildRemoteAgentRollbackScript = buildRemoteAgentActivationRecoveryScript;
