use std::collections::VecDeque;

use crate::v1;

#[derive(Debug, Clone)]
pub(super) struct QueuedBatch {
    pub(super) batch: v1::EventBatch,
    pub(super) bytes: usize,
    pub(super) digest: [u8; 32],
}

impl QueuedBatch {
    pub(super) fn new(batch: v1::EventBatch, digest: [u8; 32]) -> Self {
        let bytes = batch.batch_id.len()
            + batch.server_epoch.len()
            + batch.consumer_id.len()
            + batch
                .events
                .iter()
                .map(|event| event.event_id.len() + event.canonical_payload.len() + 8)
                .sum::<usize>();
        Self {
            batch,
            bytes,
            digest,
        }
    }

    pub(super) fn event_count(&self) -> usize {
        self.batch.events.len()
    }

    pub(super) fn last_sequence(&self) -> Option<u64> {
        self.batch.events.last().map(|event| event.sequence)
    }
}

#[derive(Debug, Default)]
pub(super) struct ConsumerQueue {
    batches: VecDeque<QueuedBatch>,
    events: usize,
    bytes: usize,
}

impl ConsumerQueue {
    pub(super) fn push(&mut self, batch: QueuedBatch) {
        self.events += batch.event_count();
        self.bytes += batch.bytes;
        self.batches.push_back(batch);
    }

    pub(super) fn pop(&mut self) -> Option<QueuedBatch> {
        let batch = self.batches.pop_front()?;
        self.events -= batch.event_count();
        self.bytes -= batch.bytes;
        Some(batch)
    }

    pub(super) fn find_digest(&self, batch_id: &str) -> Option<[u8; 32]> {
        self.batches
            .iter()
            .find(|queued| queued.batch.batch_id == batch_id)
            .map(|queued| queued.digest)
    }

    pub(super) fn last_sequence(&self) -> Option<u64> {
        self.batches.back().and_then(QueuedBatch::last_sequence)
    }

    pub(super) fn events(&self) -> usize {
        self.events
    }

    pub(super) fn bytes(&self) -> usize {
        self.bytes
    }

    pub(super) fn clear(&mut self) {
        self.batches.clear();
        self.events = 0;
        self.bytes = 0;
    }
}
