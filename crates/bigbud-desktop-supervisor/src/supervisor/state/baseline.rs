use super::consumer::BaselineIdentity;
use super::{BASELINE_IDENTITY_HISTORY_LIMIT, ConsumerState, Supervisor, SupervisorError};
use crate::v1;

impl Supervisor {
    pub fn install_baseline(
        &mut self,
        baseline: &v1::InstallBaseline,
    ) -> Result<u64, SupervisorError> {
        let consumer = self.consumer_mut(&baseline.consumer_id, baseline.consumer_generation)?;
        if baseline.server_epoch != consumer.server_epoch {
            return Err(SupervisorError::ServerEpochMismatch);
        }
        if baseline.recovery_id.is_empty() {
            return Err(SupervisorError::InvalidBaselineIdentity);
        }
        if let Some(installed) = consumer
            .baseline_identities
            .iter()
            .find(|installed| installed.recovery_id == baseline.recovery_id)
        {
            return if installed.acknowledged_sequence == baseline.applied_projection_sequence {
                Ok(installed.acknowledged_sequence)
            } else {
                Err(SupervisorError::BaselineIdentityConflict)
            };
        }
        if baseline.applied_projection_sequence < consumer.acknowledged_sequence {
            return Err(SupervisorError::BaselineMovedBackward);
        }
        if consumer.in_flight.is_some() || consumer.queue.events() != 0 {
            return Err(SupervisorError::BaselineStateConflict);
        }
        if consumer.baseline_identities.len() >= BASELINE_IDENTITY_HISTORY_LIMIT {
            return Err(SupervisorError::BaselineIdentityCapacity);
        }

        let sequence = baseline.applied_projection_sequence;
        consumer.persisted_sequence = sequence;
        consumer.sent_sequence = sequence;
        consumer.received_sequence = sequence;
        consumer.applied_sequence = sequence;
        consumer.acknowledged_sequence = sequence;
        consumer.acknowledged_batches.clear();
        consumer.last_acknowledged_batch = None;
        consumer.baseline_identities.push_back(BaselineIdentity {
            recovery_id: baseline.recovery_id.clone(),
            acknowledged_sequence: sequence,
        });
        consumer.state = ConsumerState::Ready;
        Ok(sequence)
    }
}
