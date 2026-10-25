use super::*;

impl OperationRecord {
    /// Only a terminal result ages out. Running work never expires, however
    /// long it runs or however long the client stays away.
    pub(super) fn is_expired(&self, now: Instant) -> bool {
        self.state.is_terminal() && self.expires_at <= now
    }

    fn drop_retained_output(&mut self) {
        self.output.clear();
        self.retained_bytes = 0;
        self.first_retained_sequence = self.next_sequence;
    }
}

impl OperationRegistry {
    pub fn prune(&mut self, now: Instant) {
        self.operations.retain(|_, record| !record.is_expired(now));
    }

    pub fn forget_accepted(&mut self, operation_id: &str) {
        if self
            .operations
            .get(operation_id)
            .is_some_and(|record| record.state == OperationState::Accepted)
        {
            self.operations.remove(operation_id);
        }
    }

    pub fn expire_non_terminal(&mut self, now: Instant) {
        let operation_ids = self
            .operations
            .iter()
            .filter_map(|(operation_id, record)| {
                (!record.state.is_terminal()).then_some(operation_id.clone())
            })
            .collect::<Vec<_>>();
        for operation_id in operation_ids {
            let _ = self.complete(
                &operation_id,
                OperationState::Expired,
                None,
                Some("AGENT_RESTARTED".to_owned()),
                now,
            );
        }
    }

    /// Frees one slot by dropping the terminal result that expires first.
    /// Non-terminal work is never evicted.
    pub(super) fn evict_oldest_terminal(&mut self) -> bool {
        let oldest = self
            .operations
            .iter()
            .filter(|(_, record)| record.state.is_terminal())
            .min_by_key(|(_, record)| record.expires_at)
            .map(|(operation_id, _)| operation_id.clone());
        oldest
            .and_then(|operation_id| self.operations.remove(&operation_id))
            .is_some()
    }

    /// Keeps terminal output within its total budget, dropping the output of
    /// the oldest terminal results first. Their state and exit code remain.
    pub(super) fn enforce_terminal_output_budget(&mut self) {
        loop {
            let retained: usize = self
                .operations
                .values()
                .filter(|record| record.state.is_terminal())
                .map(|record| record.retained_bytes)
                .sum();
            if retained <= self.max_terminal_output_bytes {
                return;
            }
            let Some(oldest) = self
                .operations
                .values_mut()
                .filter(|record| record.state.is_terminal() && record.retained_bytes > 0)
                .min_by_key(|record| record.expires_at)
            else {
                return;
            };
            oldest.drop_retained_output();
        }
    }
}
