use super::{CredentialLane, MAX_ATTEMPTS, production_verb};
use crate::v1::{self, request::Operation};

#[test]
fn attempts_are_bounded_per_generation_and_reset_by_a_new_one() {
    let mut lane = CredentialLane::default();
    let first = [1; 32];
    assert_eq!(lane.remaining(first), MAX_ATTEMPTS);
    for left in (0..MAX_ATTEMPTS).rev() {
        lane.record_failure(first);
        assert_eq!(lane.remaining(first), left);
    }
    // Connect/Disconnect rotate the generation; the old count does not carry over.
    assert_eq!(lane.remaining([2; 32]), MAX_ATTEMPTS);
}

#[test]
fn only_the_four_credential_verbs_are_credential_verbs() {
    for operation in [
        Operation::InspectCredential(v1::InspectCredential {}),
        Operation::CredentialUnlockOpen(v1::CredentialUnlockOpen::default()),
        Operation::CredentialUnlockCommit(v1::CredentialUnlockCommit::default()),
        Operation::CredentialLock(v1::CredentialLock {}),
    ] {
        assert!(production_verb(&operation));
    }
    assert!(!production_verb(&Operation::UnlockPosixPassword(
        v1::Empty {}
    )));
}
