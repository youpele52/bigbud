use super::*;
use std::num::NonZeroU32;

pub(crate) fn root() -> ExecutionRoot {
    ExecutionRoot {
        pid: NonZeroU32::new(42).unwrap(),
        creation_identity: "birth-1".into(),
        generation: "worker-1".into(),
    }
}
#[test]
fn reused_pid_is_never_permission_to_kill_replacement() {
    assert_eq!(
        retirement_decision(
            &root(),
            &Observation::Alive {
                creation_identity: "birth-2".into()
            }
        ),
        RetirementDecision::RecordedLifetimeEnded
    );
    assert_eq!(
        retirement_decision(
            &root(),
            &Observation::Alive {
                creation_identity: "birth-1".into()
            }
        ),
        RetirementDecision::RetireRecordedLifetime
    );
}
#[test]
fn unavailable_or_invalid_identity_never_settles() {
    assert_eq!(
        retirement_decision(&root(), &Observation::Unavailable),
        RetirementDecision::Unknown
    );
    assert_eq!(
        retirement_decision(
            &root(),
            &Observation::Alive {
                creation_identity: String::new()
            }
        ),
        RetirementDecision::Unknown
    );
    let invalid = ExecutionRoot {
        generation: String::new(),
        ..root()
    };
    assert_eq!(
        retirement_decision(&invalid, &Observation::Gone),
        RetirementDecision::Unknown
    );
}
