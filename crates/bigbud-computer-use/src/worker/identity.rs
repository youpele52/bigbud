use std::num::NonZeroU32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionRoot {
    pub pid: NonZeroU32,
    /// OS creation identity, not a wall-clock approximation or claimed PID.
    pub creation_identity: String,
    pub generation: String,
}
impl ExecutionRoot {
    pub fn valid(&self) -> bool {
        super::super::guard::record::valid_id(&self.creation_identity)
            && super::super::guard::record::valid_id(&self.generation)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    Alive { creation_identity: String },
    Gone,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetirementDecision {
    /// Permission to request retirement of ONLY this recorded lifetime. An OS
    /// adapter still needs a race-safe retained process/group/Job identity.
    RetireRecordedLifetime,
    RecordedLifetimeEnded,
    Unknown,
}

pub fn retirement_decision(root: &ExecutionRoot, observation: &Observation) -> RetirementDecision {
    if !root.valid() {
        return RetirementDecision::Unknown;
    }
    match observation {
        Observation::Gone => RetirementDecision::RecordedLifetimeEnded,
        Observation::Alive { creation_identity }
            if creation_identity == &root.creation_identity =>
        {
            RetirementDecision::RetireRecordedLifetime
        }
        Observation::Alive { creation_identity }
            if super::super::guard::record::valid_id(creation_identity) =>
        {
            RetirementDecision::RecordedLifetimeEnded
        }
        Observation::Alive { .. } | Observation::Unavailable => RetirementDecision::Unknown,
    }
}
