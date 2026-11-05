use super::record::SafetyRecord;
use crate::worker::{Observation, RetirementDecision, retirement_decision};

#[derive(Debug, PartialEq, Eq)]
pub struct Recovery {
    pub record: SafetyRecord,
    pub unsettled_roots: usize,
}

/// Does not kill, reopen admission, clear a latch or interpret a missing/corrupt
/// record as legacy. Observations must be supplied by a qualified identity reader.
pub fn recover(mut record: SafetyRecord, observations: &[Observation]) -> Option<Recovery> {
    if !record.valid() || observations.len() != record.roots.len() {
        return None;
    }
    let mut unsettled = Vec::new();
    for (root, observation) in record.roots.iter().zip(observations) {
        if retirement_decision(root, observation) != RetirementDecision::RecordedLifetimeEnded {
            unsettled.push(root.clone());
        }
    }
    if record.armed || !unsettled.is_empty() {
        record.latched = true;
        record.reason = "unclean_recovery".into();
        record.pause_epoch = record.pause_epoch.checked_add(1)?;
        record.input_uncertain = true;
    }
    record.roots = unsettled;
    let unsettled_roots = record.roots.len();
    // Armed stays set until a later verified clean-retirement transaction.
    Some(Recovery {
        record,
        unsettled_roots,
    })
}
