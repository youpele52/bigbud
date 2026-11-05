//! Human-only durable transitions (M4.uncertainty, M3.controller). Each needs
//! the `HumanControl` capability, which only the authenticated human-control
//! channel constructs; no model, provider or safety-renderer route reaches
//! these. None of them clears the latch: a fresh Resume challenge is still
//! required afterwards, and nothing here replays or releases input.
use super::control::{HumanControl, ResumePrerequisites};
use crate::guard::record::PolicyBinding;
use crate::guard::{ControllerLease, GuardFence, SafetySink, Settlement, TransitionError};

/// The user confirmed held keys/buttons are released after confirmed
/// retirement. Refuses while any execution root is unsettled.
pub fn acknowledge_input_state<S: SafetySink>(
    fence: &mut GuardFence<S>,
    _human: &HumanControl,
    expected_pause_epoch: u64,
) -> Result<(), TransitionError<S::Error>> {
    fence.acknowledge_input_state(expected_pause_epoch)
}

/// Returns the minted binding (namespace, nothing acknowledged yet).
pub fn bind_first_controller<S: SafetySink>(
    fence: &mut GuardFence<S>,
    _human: &HumanControl,
    lease: ControllerLease,
) -> Result<PolicyBinding, TransitionError<S::Error>> {
    fence.bind_controller(lease)
}

/// Fences and retires the old controller's authority; returns the new
/// controller's minted binding (its namespace derives from the new epoch).
pub fn take_over_controller<S: SafetySink>(
    fence: &mut GuardFence<S>,
    _human: &HumanControl,
    lease: ControllerLease,
) -> Result<PolicyBinding, TransitionError<S::Error>> {
    fence.take_over(lease)
}

/// The settlement facts Resume needs, from the fence's record (the last
/// state committed or, after a failed write, still pending) plus its write
/// status: a failed write counts as unconfirmed retirement.
pub fn settlement_facts<S: SafetySink>(
    fence: &GuardFence<S>,
    policy_acknowledged: bool,
    control_healthy: bool,
    feature_enabled: bool,
) -> ResumePrerequisites {
    let settlement = fence.settlement();
    ResumePrerequisites {
        retirement_confirmed: !fence.persistence_failed()
            && !matches!(settlement, Settlement::RetirementUnknown { .. }),
        input_state_acknowledged: !matches!(
            settlement,
            Settlement::InputUncertain | Settlement::RetirementUnknown { .. }
        ),
        policy_acknowledged,
        control_healthy,
        feature_enabled,
    }
}
