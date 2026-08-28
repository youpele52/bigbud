use std::collections::VecDeque;

use super::super::queue::{ConsumerQueue, QueuedBatch};
use super::batch_identity::BatchIdentity;
use crate::v1;

#[derive(Debug)]
pub(super) struct InFlight {
    pub(super) queued: QueuedBatch,
    pub(super) sent_at_ms: u64,
}

#[derive(Debug)]
pub(super) struct Consumer {
    pub(super) id: String,
    pub(super) generation: u64,
    pub(super) server_epoch: String,
    pub(super) state: super::ConsumerState,
    pub(super) persisted_sequence: u64,
    pub(super) sent_sequence: u64,
    pub(super) received_sequence: u64,
    pub(super) applied_sequence: u64,
    pub(super) acknowledged_sequence: u64,
    pub(super) queue: ConsumerQueue,
    pub(super) in_flight: Option<InFlight>,
    pub(super) acknowledged_batches: VecDeque<BatchIdentity>,
    pub(super) last_acknowledged_batch: Option<v1::EventBatch>,
}

impl Consumer {
    pub(super) fn recovery(
        &self,
        kind: v1::RecoveryKind,
        reason_code: &'static str,
    ) -> super::RecoveryAction {
        super::RecoveryAction {
            consumer_id: self.id.clone(),
            consumer_generation: self.generation,
            from_sequence_exclusive: self.acknowledged_sequence,
            kind,
            reason_code,
        }
    }

    pub(super) fn next_expected_sequence(&self) -> u64 {
        match self.queue.last_sequence().or_else(|| {
            self.in_flight
                .as_ref()
                .and_then(|flight| flight.queued.last_sequence())
        }) {
            Some(sequence) => sequence.saturating_add(1),
            None => self.acknowledged_sequence.saturating_add(1),
        }
    }
}
