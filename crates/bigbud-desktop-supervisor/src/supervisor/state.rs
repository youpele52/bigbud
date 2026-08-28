use std::collections::HashMap;

use self::batch_identity::{
    BatchIdentity, digest as batch_digest, expected_id as expected_batch_id,
};
pub use self::errors::SupervisorError;
use super::queue::QueuedBatch;
use crate::v1;

use self::consumer::{Consumer, InFlight};

const ACKNOWLEDGED_BATCH_HISTORY_LIMIT: usize = 256;
// Detached generation fences use logical LRU eviction at this hard capacity.
// They intentionally have no wall-clock TTL, so behavior is independent of clock changes.
const DEFAULT_DETACHED_GENERATION_TOMBSTONE_CAPACITY: usize = 1_024;

pub fn canonical_batch_id(batch: &v1::EventBatch) -> String {
    expected_batch_id(batch)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_consumers: usize,
    pub max_consumer_identities: usize,
    pub max_queue_events: usize,
    pub max_queue_bytes: usize,
    pub max_in_flight_events: usize,
    pub acknowledgement_timeout_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_consumers: 5,
            max_consumer_identities: DEFAULT_DETACHED_GENERATION_TOMBSTONE_CAPACITY,
            max_queue_events: 2_000,
            max_queue_bytes: 16 * 1024 * 1024,
            max_in_flight_events: 256,
            acknowledgement_timeout_ms: 15_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsumerState {
    Ready,
    AwaitingAcknowledgement,
    Stalled,
    Overloaded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub batch: v1::EventBatch,
    pub sent_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryAction {
    pub consumer_id: String,
    pub consumer_generation: u64,
    pub from_sequence_exclusive: u64,
    pub kind: v1::RecoveryKind,
    pub reason_code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GenerationFence {
    generation: u64,
    server_epoch: String,
    acknowledged_sequence: u64,
    last_touched: u64,
}

#[derive(Debug)]
pub struct Supervisor {
    limits: Limits,
    consumers: HashMap<String, Consumer>,
    generation_fences: HashMap<String, GenerationFence>,
    generation_fence_clock: u64,
}

impl Supervisor {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            consumers: HashMap::new(),
            generation_fences: HashMap::new(),
            generation_fence_clock: 0,
        }
    }

    pub fn enqueue(
        &mut self,
        batch: v1::EventBatch,
    ) -> Result<Option<RecoveryAction>, SupervisorError> {
        let limits = self.limits;
        let consumer = self.consumer_mut(&batch.consumer_id, batch.consumer_generation)?;
        if consumer.server_epoch != batch.server_epoch {
            return Err(SupervisorError::ServerEpochMismatch);
        }
        if batch.events.is_empty() {
            return Err(SupervisorError::EmptyBatch);
        }
        let digest = batch_digest(&batch);
        if let Some(existing) = consumer
            .acknowledged_batches
            .iter()
            .find(|existing| existing.id == batch.batch_id)
        {
            return if existing.digest == digest {
                Ok(None)
            } else {
                Err(SupervisorError::BatchIdentityConflict)
            };
        }
        if let Some(existing) = consumer.in_flight.as_ref().and_then(|flight| {
            (flight.queued.batch.batch_id == batch.batch_id).then_some(flight.queued.digest)
        }) {
            return if existing == digest {
                Ok(None)
            } else {
                Err(SupervisorError::BatchIdentityConflict)
            };
        }
        if let Some(existing) = consumer.queue.find_digest(&batch.batch_id) {
            return if existing == digest {
                Ok(None)
            } else {
                Err(SupervisorError::BatchIdentityConflict)
            };
        }
        if batch.batch_id != expected_batch_id(&batch) {
            return Err(SupervisorError::InvalidBatchIdentity);
        }
        let mut expected = consumer.next_expected_sequence();
        for event in &batch.events {
            if event.sequence != expected {
                return Err(SupervisorError::NonContiguousSequence);
            }
            expected = expected.saturating_add(1);
        }
        let queued = QueuedBatch::new(batch, digest);
        if queued.event_count() > limits.max_in_flight_events {
            return Err(SupervisorError::InFlightLimit);
        }
        if consumer.queue.events() + queued.event_count() > limits.max_queue_events
            || consumer.queue.bytes() + queued.bytes > limits.max_queue_bytes
        {
            consumer.state = ConsumerState::Overloaded;
            consumer.queue.clear();
            consumer.in_flight = None;
            return Ok(Some(consumer.recovery(
                v1::RecoveryKind::Overload,
                "consumer_queue_bound_reached",
            )));
        }
        if let Some(sequence) = queued.last_sequence() {
            consumer.persisted_sequence = sequence;
        }
        consumer.queue.push(queued);
        Ok(None)
    }

    pub fn duplicate_delivery(
        &mut self,
        batch: &v1::EventBatch,
        now_ms: u64,
    ) -> Result<Option<Delivery>, SupervisorError> {
        let consumer = self.consumer_mut(&batch.consumer_id, batch.consumer_generation)?;
        if consumer.server_epoch != batch.server_epoch {
            return Err(SupervisorError::ServerEpochMismatch);
        }
        if batch.events.is_empty() {
            return Err(SupervisorError::EmptyBatch);
        }
        let digest = batch_digest(batch);
        if let Some(flight) = consumer.in_flight.as_ref()
            && flight.queued.batch.batch_id == batch.batch_id
        {
            if flight.queued.digest != digest {
                return Err(SupervisorError::BatchIdentityConflict);
            }
            return Ok(Some(Delivery {
                batch: flight.queued.batch.clone(),
                sent_sequence: flight.queued.last_sequence().unwrap_or(0),
            }));
        }
        if consumer
            .acknowledged_batches
            .iter()
            .any(|identity| identity.id == batch.batch_id && identity.digest == digest)
        {
            if let Some(last) = consumer.last_acknowledged_batch.as_ref()
                && last.batch_id == batch.batch_id
            {
                return Ok(Some(Delivery {
                    sent_sequence: last.events.last().map_or(0, |event| event.sequence),
                    batch: last.clone(),
                }));
            }
            let _ = now_ms;
        }
        if batch.batch_id != expected_batch_id(batch) {
            return Err(SupervisorError::InvalidBatchIdentity);
        }
        Ok(None)
    }

    pub fn recovery_required(
        &self,
        consumer_id: &str,
        generation: u64,
        kind: v1::RecoveryKind,
        reason_code: &'static str,
    ) -> Result<RecoveryAction, SupervisorError> {
        Ok(self
            .consumer(consumer_id, generation)?
            .recovery(kind, reason_code))
    }

    pub fn next_delivery(
        &mut self,
        consumer_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<Option<Delivery>, SupervisorError> {
        let consumer = self.consumer_mut(consumer_id, generation)?;
        if consumer.in_flight.is_some() {
            return Ok(None);
        }
        let Some(queued) = consumer.queue.pop() else {
            return Ok(None);
        };
        let Some(sent_sequence) = queued.last_sequence() else {
            return Err(SupervisorError::EmptyBatch);
        };
        consumer.sent_sequence = sent_sequence;
        consumer.state = ConsumerState::AwaitingAcknowledgement;
        let delivery = Delivery {
            batch: queued.batch.clone(),
            sent_sequence,
        };
        consumer.in_flight = Some(InFlight {
            queued,
            sent_at_ms: now_ms,
        });
        Ok(Some(delivery))
    }

    pub fn acknowledge(&mut self, ack: &v1::ApplicationAck) -> Result<(), SupervisorError> {
        let consumer = self.consumer_mut(&ack.consumer_id, ack.consumer_generation)?;
        let Some(in_flight) = consumer.in_flight.as_ref() else {
            if consumer.acknowledged_batches.iter().any(|identity| {
                identity.id == ack.batch_id
                    && identity.acknowledged_sequence == ack.applied_through_sequence
                    && ack.received_through_sequence == ack.applied_through_sequence
            }) {
                return Ok(());
            }
            return Err(SupervisorError::UnknownBatch);
        };
        if in_flight.queued.batch.batch_id != ack.batch_id {
            return Err(SupervisorError::UnknownBatch);
        }
        if ack.received_through_sequence > consumer.sent_sequence
            || ack.applied_through_sequence > consumer.sent_sequence
        {
            return Err(SupervisorError::AckBeyondSent);
        }
        if ack.received_through_sequence < ack.applied_through_sequence
            || ack.applied_through_sequence != consumer.sent_sequence
        {
            return Err(SupervisorError::IncompleteAck);
        }
        if ack.applied_through_sequence < consumer.applied_sequence {
            return Err(SupervisorError::AckMovedBackward);
        }
        consumer.received_sequence = ack.received_through_sequence;
        consumer.applied_sequence = ack.applied_through_sequence;
        consumer.acknowledged_sequence = ack.applied_through_sequence;
        consumer.acknowledged_batches.push_back(BatchIdentity {
            id: in_flight.queued.batch.batch_id.clone(),
            digest: in_flight.queued.digest,
            acknowledged_sequence: ack.applied_through_sequence,
        });
        consumer.last_acknowledged_batch = Some(in_flight.queued.batch.clone());
        if consumer.acknowledged_batches.len() > ACKNOWLEDGED_BATCH_HISTORY_LIMIT {
            consumer.acknowledged_batches.pop_front();
        }
        consumer.in_flight = None;
        consumer.state = ConsumerState::Ready;
        Ok(())
    }

    pub fn reset_for_replay(
        &mut self,
        consumer_id: &str,
        generation: u64,
    ) -> Result<u64, SupervisorError> {
        let consumer = self.consumer_mut(consumer_id, generation)?;
        consumer.queue.clear();
        consumer.in_flight = None;
        consumer.persisted_sequence = consumer.acknowledged_sequence;
        consumer.sent_sequence = consumer.acknowledged_sequence;
        consumer.received_sequence = consumer.acknowledged_sequence;
        consumer.applied_sequence = consumer.acknowledged_sequence;
        consumer.state = ConsumerState::Ready;
        Ok(consumer.acknowledged_sequence)
    }

    pub fn state(
        &self,
        consumer_id: &str,
        generation: u64,
    ) -> Result<ConsumerState, SupervisorError> {
        Ok(self.consumer(consumer_id, generation)?.state)
    }

    fn consumer(&self, id: &str, generation: u64) -> Result<&Consumer, SupervisorError> {
        let consumer = self
            .consumers
            .get(id)
            .ok_or(SupervisorError::ConsumerMissing)?;
        if consumer.generation != generation {
            return Err(SupervisorError::StaleConsumerGeneration);
        }
        Ok(consumer)
    }

    fn consumer_mut(
        &mut self,
        id: &str,
        generation: u64,
    ) -> Result<&mut Consumer, SupervisorError> {
        let consumer = self
            .consumers
            .get_mut(id)
            .ok_or(SupervisorError::ConsumerMissing)?;
        if consumer.generation != generation {
            return Err(SupervisorError::StaleConsumerGeneration);
        }
        Ok(consumer)
    }
}

mod attach;
mod batch_identity;
mod consumer;
mod errors;
mod metrics;
mod timeout;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "state/tombstone_tests.rs"]
mod tombstone_tests;
