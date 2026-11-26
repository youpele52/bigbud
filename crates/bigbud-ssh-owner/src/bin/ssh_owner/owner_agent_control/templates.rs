//! The generated U25 templates (`templates/*.sh`). Regenerate them with
//! `bun run --cwd apps/server agent-control:templates`; a vitest fails when a
//! file is stale, so the owner and the legacy builders cannot drift.

pub(super) const ADMISSION_DEATH_OBSERVE: &str =
    include_str!("templates/admission_death_observe.sh");
pub(super) const BACKEND_RUNTIME_PROBE: &str = include_str!("templates/backend_runtime_probe.sh");
pub(super) const CONTROL_ROOT: &str = include_str!("templates/control_root.sh");
pub(super) const HOST_CLOCK: &str = include_str!("templates/host_clock.sh");
pub(super) const IDENTITY_CHECK_DEFAULT: &str = include_str!("templates/identity_check.default.sh");
pub(super) const IDENTITY_CHECK_PATH: &str = include_str!("templates/identity_check.path.sh");
pub(super) const IDENTITY_CHECK: &str = include_str!("templates/identity_check.sh");
pub(super) const INBOX_ADOPT_RESERVED: &str = include_str!("templates/inbox_adopt.reserved.sh");
pub(super) const INBOX_ADOPT_UNRESERVED: &str = include_str!("templates/inbox_adopt.unreserved.sh");
pub(super) const INSTALL_UPLOAD_RESERVED: &str =
    include_str!("templates/install_upload.reserved.sh");
pub(super) const INSTALL_UPLOAD_UNRESERVED: &str =
    include_str!("templates/install_upload.unreserved.sh");
pub(super) const INVENTORY: &str = include_str!("templates/inventory.sh");
pub(super) const ISOLATED_LAUNCH: &str = include_str!("templates/isolated_launch.sh");
pub(super) const ORPHAN_DELETE: &str = include_str!("templates/orphan_delete.sh");
pub(super) const PLACED_PROBE: &str = include_str!("templates/placed_probe.sh");
pub(super) const PLATFORM_PROBE: &str = include_str!("templates/platform_probe.sh");
pub(super) const READ_ONLY_STATUS: &str = include_str!("templates/read_only_status.sh");
pub(super) const REGISTRY_CAS_ABSENT: &str = include_str!("templates/registry_cas.absent.sh");
pub(super) const REGISTRY_CAS_PRESENT: &str = include_str!("templates/registry_cas.present.sh");
pub(super) const REGISTRY_READ: &str = include_str!("templates/registry_read.sh");
pub(super) const REMOVAL: &str = include_str!("templates/removal.sh");
pub(super) const REMOVAL_OUTCOME: &str = include_str!("templates/removal_outcome.sh");
pub(super) const REMOVAL_RESUME: &str = include_str!("templates/removal_resume.sh");
pub(super) const REPLACEMENT_LAUNCH: &str = include_str!("templates/replacement_launch.sh");
pub(super) const RETIREMENT_DELETE: &str = include_str!("templates/retirement_delete.sh");
pub(super) const RUNTIME_PROBE_DEFAULT: &str = include_str!("templates/runtime_probe.default.sh");
pub(super) const RUNTIME_PROBE_EXTERNAL: &str = include_str!("templates/runtime_probe.external.sh");
pub(super) const SOCKET_GONE: &str = include_str!("templates/socket_gone.sh");
pub(super) const SOCKET_LIVE: &str = include_str!("templates/socket_live.sh");
pub(super) const STAGE_FENCE_REVOKE: &str = include_str!("templates/stage_fence_revoke.sh");
pub(super) const STATE_ABSENT: &str = include_str!("templates/state_absent.sh");
pub(super) const SUPERVISOR_OBSERVE_CANDIDATE_EXIT: &str =
    include_str!("templates/supervisor_observe.candidateExit.sh");
pub(super) const SUPERVISOR_OBSERVE_CANDIDATE_STARTUP: &str =
    include_str!("templates/supervisor_observe.candidateStartup.sh");
pub(super) const SUPERVISOR_OBSERVE_LAUNCH_EXIT: &str =
    include_str!("templates/supervisor_observe.launchExit.sh");
pub(super) const SUPERVISOR_OBSERVE_RAW: &str = include_str!("templates/supervisor_observe.raw.sh");
pub(super) const SUPERVISOR_OBSERVE_REPLACEMENT_DEATH: &str =
    include_str!("templates/supervisor_observe.replacementDeath.sh");
pub(super) const SUPERVISOR_OBSERVE_REPLACEMENT_READINESS: &str =
    include_str!("templates/supervisor_observe.replacementReadiness.sh");
pub(super) const SUPERVISOR_OBSERVE_RETIREMENT_EXIT: &str =
    include_str!("templates/supervisor_observe.retirementExit.sh");
pub(super) const SUPERVISOR_OBSERVE_RETIREMENT_STATE: &str =
    include_str!("templates/supervisor_observe.retirementState.sh");
pub(super) const SUPERVISOR_RESTART: &str = include_str!("templates/supervisor_restart.sh");
pub(super) const SUPERVISOR_SHUTDOWN: &str = include_str!("templates/supervisor_shutdown.sh");
