//! Read-only verification of one hydrated retirement-mirror row.

use super::super::retirement::{self, Hydrated};
use super::RETIREMENT;
use crate::v1::{ErrorCode, ProofRetirementEntry};

const MAX_TARGET: usize = 1_024;
const MAX_EPOCH: usize = 128;
const MAX_DETAIL: usize = 4_096;

/// Classifies one row with the journal's own identity rules. Only a bound row
/// whose exact recorded instance is verifiably gone may be admitted; an intent,
/// a live instance, PID reuse and a namespace mismatch all refuse.
pub(super) fn check(entry: &ProofRetirementEntry) -> Result<Hydrated, ErrorCode> {
    if entry.target_id.is_empty()
        || entry.target_id.len() > MAX_TARGET
        || entry.owner_epoch.len() > MAX_EPOCH
        || entry.detail.len() > MAX_DETAIL
        || !matches!(entry.kind.as_str(), "owner" | "master" | "connector")
    {
        return Err(RETIREMENT);
    }
    match retirement::observe_hydrated(&entry.state, entry.pid, entry.start, entry.namespace) {
        Ok(Hydrated::Gone) => Ok(Hydrated::Gone),
        Ok(_) | Err(_) => Err(RETIREMENT),
    }
}
