use crate::monitor_v1 as v1;
use bigbud_system::{lifecycle::Service, recovery::CollectionState};
use std::time::Instant;

pub(super) fn frame(service: &Service, epoch: u64, now: Instant) -> v1::Frame {
    let (phase, attempts, retry_after_ms, reason) = match service.collection_state() {
        CollectionState::Healthy => (v1::CollectionPhase::Healthy, 0, 0, String::new()),
        CollectionState::Retrying {
            attempts,
            next_retry_at,
            reason,
        } => (
            v1::CollectionPhase::Retrying,
            u32::from(attempts),
            next_retry_at.saturating_duration_since(now).as_millis() as u64,
            reason.to_string(),
        ),
        CollectionState::Failed { reason } => {
            (v1::CollectionPhase::Failed, 3, 0, reason.to_string())
        }
    };
    v1::Frame {
        payload: Some(v1::frame::Payload::CollectionStatus(v1::CollectionStatus {
            phase: phase.into(),
            attempts,
            retry_after_ms,
            reason,
            epoch,
        })),
    }
}
