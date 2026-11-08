//! In-place policy admission after activation. TS commits the policy identity and barriers
//! before publishing; a regressing or same-version rewrite of anything but the target drain
//! barrier is a protocol fault that requires a fresh snapshot.
use super::{Admission, AdmissionError, CompactState};
use crate::organization::admission_validation::MAX_SAFE_UINT;
use crate::organization::protocol::policy::v1::Policy;

impl CompactState {
    pub(super) fn update_policy(&mut self, policy: Policy) -> Result<Admission, AdmissionError> {
        let current = self.policy.as_ref().ok_or(AdmissionError::Resync)?;
        if !self.active
            || self.staging.is_some()
            || !valid_policy(&policy)
            || !admissible(current, &policy)
        {
            return Err(AdmissionError::Resync);
        }
        self.policy_version = policy.version;
        self.policy = Some(policy);
        Ok(Admission::PolicyUpdated)
    }
}

fn valid_policy(policy: &Policy) -> bool {
    policy.version > 0
        && policy.version <= MAX_SAFE_UINT
        && !policy.fingerprint.is_empty()
        && policy.fingerprint.len() <= 256
        && policy.scheduling.is_some()
        && policy
            .older_policy_changed_at_ms
            .is_none_or(|value| value <= MAX_SAFE_UINT)
}

/// A newer version may change anything. The same version may only move the target drain
/// barrier forward (Undo or a target-grace barrier), never backwards or away.
pub(super) fn admissible(current: &Policy, next: &Policy) -> bool {
    if next.version != current.version {
        return next.version > current.version;
    }
    let (Some(old), Some(new)) = (current.scheduling.as_ref(), next.scheduling.as_ref()) else {
        return false;
    };
    let barrier_advances = match (old.target_not_before_ms, new.target_not_before_ms) {
        (None, _) => true,
        (Some(old), Some(new)) => new >= old,
        (Some(_), None) => false,
    };
    let mut unchanged = *new;
    unchanged.target_not_before_ms = old.target_not_before_ms;
    barrier_advances
        && next.fingerprint == current.fingerprint
        && next.older_policy_changed_at_ms == current.older_policy_changed_at_ms
        && &unchanged == old
}
