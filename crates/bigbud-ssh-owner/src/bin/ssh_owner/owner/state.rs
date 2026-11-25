use super::reconnect::ReconnectAdmission;
use super::retirement::Retirement;
use super::{
    DeploymentOperation, SnapshotCancelInbox, StageBinding, TerminalPreparation, guarded_write,
    picker_cancel, posix_picker, terminal, workspace_mode,
};
#[cfg(target_os = "linux")]
use super::{opencode, tracked_push};
use crate::{
    Token,
    owner_agent_proxy::{AgentProxyFixture, AgentProxyLease},
    owner_grants::Grants,
    owner_storage::Storage,
    owner_trust::TrustApproval,
    transport::Transport,
};

pub(crate) struct Owner {
    pub(super) target: String,
    pub(super) epoch: Token,
    pub(super) generation: Token,
    /// Authenticated profile binding used for peer enrollment metadata.
    pub(super) profile: Vec<u8>,
    /// Owner-private profile state root for peer enrollment; absent off POSIX.
    pub(super) peer_state_dir: Option<std::path::PathBuf>,
    pub(super) retirement: Option<Retirement>,
    pub(super) storage: Storage,
    pub(crate) transport: Transport,
    pub(super) grants: Grants,
    pub(super) trust: TrustApproval,
    pub(super) reconnect: ReconnectAdmission,
    #[cfg(target_os = "linux")]
    pub(super) jump_picker: Option<crate::transport::jump_binding::JumpPicker>,
    pub(super) terminal: Option<terminal::LiveTerminal>,
    pub(crate) supervised_terminal: bool,
    pub(super) preparation: Option<TerminalPreparation>,
    pub(super) terminal_uncertain: bool,
    pub(super) agent_fixture: Option<AgentProxyFixture>,
    pub(super) agent_proxy: Option<AgentProxyLease>,
    pub(super) agent_close_uncertain: bool,
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) picker_master: Option<posix_picker::MasterPicker>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_recipe: Option<std::sync::Arc<crate::owner_opencode_v1::Recipe>>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_service: Option<std::sync::Arc<crate::owner_opencode_v1::ProductRecipe>>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_lease: Option<opencode::Lease>,
    #[cfg(target_os = "linux")]
    pub(super) tracked_push: Option<tracked_push::TrackedPushState>,
}
