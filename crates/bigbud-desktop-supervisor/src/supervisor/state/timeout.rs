use crate::v1;

use super::{ConsumerState, RecoveryAction, Supervisor, SupervisorError};

impl Supervisor {
    pub fn check_timeout(
        &mut self,
        consumer_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<Option<RecoveryAction>, SupervisorError> {
        let timeout = self.limits.acknowledgement_timeout_ms;
        let consumer = self.consumer_mut(consumer_id, generation)?;
        let Some(in_flight) = consumer.in_flight.as_ref() else {
            return Ok(None);
        };
        if consumer.state == ConsumerState::Stalled {
            return Ok(None);
        }
        if now_ms.saturating_sub(in_flight.sent_at_ms) < timeout {
            return Ok(None);
        }
        consumer.state = ConsumerState::Stalled;
        Ok(Some(consumer.recovery(
            v1::RecoveryKind::Replay,
            "application_acknowledgement_timeout",
        )))
    }

    pub fn check_timeouts(&mut self, now_ms: u64) -> Vec<RecoveryAction> {
        let timeout = self.limits.acknowledgement_timeout_ms;
        self.consumers
            .values_mut()
            .filter_map(|consumer| {
                let in_flight = consumer.in_flight.as_ref()?;
                if consumer.state == ConsumerState::Stalled
                    || now_ms.saturating_sub(in_flight.sent_at_ms) < timeout
                {
                    return None;
                }
                consumer.state = ConsumerState::Stalled;
                Some(consumer.recovery(
                    v1::RecoveryKind::Replay,
                    "application_acknowledgement_timeout",
                ))
            })
            .collect()
    }
}
