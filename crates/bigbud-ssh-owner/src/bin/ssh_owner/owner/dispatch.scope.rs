//! Which operations are lease-local control and which need the target's
//! durable state before dispatch.

use super::Operation;

/// Lease-local control reads or closes an owner-owned resource; it opens no
/// transport and never needs the target's durable state.
pub(in crate::owner) fn is_agent_control(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::AgentProxyStatus(_)
            | Operation::AgentProxyClose(_)
            | Operation::OpencodeStatus(_)
            | Operation::OpencodeClose(_)
            | Operation::GitUploadStatus(_)
            | Operation::GitUploadClose(_)
            | Operation::GitReceiveStatus(_)
            | Operation::GitReceiveClose(_)
            | Operation::ShellStatus(_)
            | Operation::ShellClose(_)
            | Operation::DeploymentStepStatus(_)
            | Operation::DeploymentStepCancel(_)
            | Operation::AgentControlStatus(_)
            | Operation::AgentControlCancel(_)
            | Operation::AgentProxyLeaseStatus(_)
            | Operation::AgentProxyLeaseClose(_)
            | Operation::ClientRelayLeaseStatus(_)
            | Operation::ClientRelayLeaseClose(_)
            | Operation::ProviderLeaseStatus(_)
            | Operation::ProviderLeaseClose(_)
    )
}

/// Operations that must hydrate the target's durable state before dispatch.
/// Local-only enrollment reads, lease control and owner-scoped alias discovery
/// carry no network admission and are excluded.
pub(in crate::owner) fn needs_storage(operation: &Operation) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if crate::owner::peer_store::owner_wide_verb(operation) {
        return false;
    }
    !(is_agent_control(operation)
        || matches!(
            operation,
            Operation::ProofEnsurePeerCoordinatorKey(_)
                | Operation::ListAliases(_)
                | Operation::OwnerShutdown(_)
        ))
}
