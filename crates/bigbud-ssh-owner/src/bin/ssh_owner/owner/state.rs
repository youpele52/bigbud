use super::reconnect::ReconnectAdmission;
use super::retirement::Retirement;
use super::targets::{Lanes, Registry as TargetRegistry, TargetAuthority};
#[cfg(target_os = "linux")]
use super::tracked_push;
use super::{
    DeploymentOperation, SnapshotCancelInbox, StageBinding, guarded_write, picker_cancel,
    workspace_mode,
};
use crate::{
    Token, owner_agent_proxy::AgentProxyFixture, owner_grants::Grants, owner_storage::Storage,
    owner_trust::TrustApproval, transport::Transport,
};

pub(crate) struct Owner {
    pub(super) target: String,
    pub(super) epoch: Token,
    pub(super) generation: Token,
    /// Authenticated profile binding used for peer enrollment metadata.
    pub(super) profile: Vec<u8>,
    /// Owner-private profile state root: retirement, peer enrollment and
    /// production master control paths. Absent off POSIX.
    pub(super) owner_state_dir: Option<std::path::PathBuf>,
    pub(super) retirement: Option<Retirement>,
    pub(super) storage: Storage,
    /// Active target transport. `None` only while a production owner is at rest
    /// between requests; every admitted request activates a resolved target.
    pub(crate) transport: Option<Transport>,
    /// All targets this epoch resolved, plus the pinned fixture target.
    pub(super) targets: TargetRegistry,
    /// Production launch mode: per-target descriptors, no pinned target.
    pub(super) production: bool,
    /// Owner-started images and config roots used to resolve descriptors.
    pub(super) authority: Option<TargetAuthority>,
    pub(super) grants: Grants,
    pub(super) trust: TrustApproval,
    pub(super) reconnect: ReconnectAdmission,
    /// Masters, PTY, agent proxy and OpenCode leases of the bound target. They
    /// swap with `target` and `generation`; each target keeps its own.
    pub(super) lanes: Lanes,
    #[cfg(target_os = "linux")]
    pub(super) jump_picker: Option<crate::transport::jump_binding::JumpPicker>,
    pub(crate) supervised_terminal: bool,
    pub(super) agent_fixture: Option<AgentProxyFixture>,
    pub(crate) agent_actions: crate::owner_agent_proxy::agent_action::Operations,
    pub(super) stage: Option<StageBinding>,
    pub(super) deployment_operation: Option<DeploymentOperation>,
    pub(super) guarded_write: Option<guarded_write::GuardedWrite>,
    pub(super) workspace_mode_observation: Option<workspace_mode::Observation>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) workspace_readiness_fixture: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) picker_cancel: Option<picker_cancel::CancelInbox>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) workspace_snapshot_cancel: Option<SnapshotCancelInbox>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) snapshot_only_fixture: bool,
    #[cfg(target_os = "linux")]
    pub(super) opencode_recipe: Option<std::sync::Arc<crate::owner_opencode_v1::Recipe>>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_service: Option<std::sync::Arc<crate::owner_opencode_v1::ProductRecipe>>,
    #[cfg(target_os = "linux")]
    pub(super) tracked_push: Option<tracked_push::TrackedPushState>,
}
