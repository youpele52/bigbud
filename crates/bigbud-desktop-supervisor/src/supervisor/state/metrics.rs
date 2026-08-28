use crate::v1;

use super::Supervisor;

impl Supervisor {
    pub fn metrics(&self, now_ms: u64) -> v1::MetricsSnapshot {
        let consumers = self
            .consumers
            .values()
            .map(|consumer| v1::ConsumerMetrics {
                consumer_id: consumer.id.clone(),
                consumer_generation: consumer.generation,
                persisted_sequence: consumer.persisted_sequence,
                sent_sequence: consumer.sent_sequence,
                received_sequence: consumer.received_sequence,
                applied_sequence: consumer.applied_sequence,
                acknowledged_sequence: consumer.acknowledged_sequence,
                queue_events: consumer.queue.events() as u64,
                queue_bytes: consumer.queue.bytes() as u64,
                acknowledgement_age_ms: consumer
                    .in_flight
                    .as_ref()
                    .map_or(0, |flight| now_ms.saturating_sub(flight.sent_at_ms)),
                state: format!("{:?}", consumer.state),
            })
            .collect();
        v1::MetricsSnapshot { consumers }
    }
}
