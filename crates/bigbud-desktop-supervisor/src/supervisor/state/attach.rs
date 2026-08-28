use super::super::queue::ConsumerQueue;
use super::{Consumer, ConsumerState, GenerationFence, Supervisor, SupervisorError};
use std::collections::VecDeque;

impl Supervisor {
    pub fn attach(
        &mut self,
        consumer_id: String,
        generation: u64,
        server_epoch: String,
        applied_sequence: u64,
    ) -> Result<u64, SupervisorError> {
        if !self.consumers.contains_key(&consumer_id)
            && self.consumers.len() >= self.limits.max_consumers
        {
            return Err(SupervisorError::ConsumerLimit);
        }
        self.reserve_consumer_identity(&consumer_id)?;
        if !self.consumers.contains_key(&consumer_id)
            && let Some(fence) = self.generation_fences.get(&consumer_id)
        {
            if generation <= fence.generation {
                return Err(SupervisorError::StaleConsumerGeneration);
            }
            if server_epoch != fence.server_epoch {
                return Err(SupervisorError::ServerEpochMismatch);
            }
            if applied_sequence != fence.acknowledged_sequence {
                return if applied_sequence < fence.acknowledged_sequence {
                    Err(SupervisorError::AttachSequenceRollback)
                } else {
                    Err(SupervisorError::AttachStateConflict)
                };
            }
        }
        if let Some(existing) = self.consumers.get(&consumer_id) {
            if generation < existing.generation {
                return Err(SupervisorError::StaleConsumerGeneration);
            }
            if applied_sequence < existing.acknowledged_sequence {
                return Err(SupervisorError::AttachSequenceRollback);
            }
            if generation == existing.generation {
                if server_epoch != existing.server_epoch {
                    return Err(SupervisorError::ServerEpochMismatch);
                }
                if applied_sequence == existing.acknowledged_sequence {
                    return Ok(existing.acknowledged_sequence);
                }
                return Err(SupervisorError::AttachStateConflict);
            }
        }
        self.consumers.insert(
            consumer_id.clone(),
            Consumer {
                id: consumer_id.clone(),
                generation,
                server_epoch: server_epoch.clone(),
                state: ConsumerState::Ready,
                persisted_sequence: applied_sequence,
                sent_sequence: applied_sequence,
                received_sequence: applied_sequence,
                applied_sequence,
                acknowledged_sequence: applied_sequence,
                queue: ConsumerQueue::default(),
                in_flight: None,
                acknowledged_batches: VecDeque::new(),
                last_acknowledged_batch: None,
            },
        );
        let last_touched = self.next_generation_fence_clock();
        self.generation_fences.insert(
            consumer_id,
            GenerationFence {
                generation,
                server_epoch,
                acknowledged_sequence: applied_sequence,
                last_touched,
            },
        );
        Ok(applied_sequence)
    }

    pub fn detach(&mut self, consumer_id: &str, generation: u64) -> Result<(), SupervisorError> {
        let Some(consumer) = self.consumers.get(consumer_id) else {
            return Ok(());
        };
        if consumer.generation != generation {
            return Ok(());
        }
        let server_epoch = consumer.server_epoch.clone();
        let acknowledged_sequence = consumer.acknowledged_sequence;
        let last_touched = self.next_generation_fence_clock();
        self.generation_fences.insert(
            consumer_id.to_owned(),
            GenerationFence {
                generation,
                server_epoch,
                acknowledged_sequence,
                last_touched,
            },
        );
        self.consumers.remove(consumer_id);
        Ok(())
    }

    fn reserve_consumer_identity(&mut self, consumer_id: &str) -> Result<(), SupervisorError> {
        if self.generation_fences.contains_key(consumer_id) {
            return Ok(());
        }
        if self.generation_fences.len() < self.limits.max_consumer_identities {
            return Ok(());
        }
        let evictable = self
            .generation_fences
            .iter()
            .filter(|(candidate, _)| !self.consumers.contains_key(*candidate))
            .min_by(|(left_id, left), (right_id, right)| {
                left.last_touched
                    .cmp(&right.last_touched)
                    .then_with(|| left_id.cmp(right_id))
            })
            .map(|(candidate, _)| candidate.clone());
        let Some(evictable) = evictable else {
            return Err(SupervisorError::ConsumerLimit);
        };
        self.generation_fences.remove(&evictable);
        Ok(())
    }

    fn next_generation_fence_clock(&mut self) -> u64 {
        self.generation_fence_clock = self.generation_fence_clock.saturating_add(1);
        self.generation_fence_clock
    }
}
