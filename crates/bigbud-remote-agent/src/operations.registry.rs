use super::*;

impl OperationRegistry {
    pub fn new(max_operations: usize, max_output_bytes: usize, retention: Duration) -> Self {
        Self {
            max_operations,
            max_output_bytes,
            retention,
            operations: HashMap::new(),
        }
    }

    pub fn accept(
        &mut self,
        operation_id: impl Into<String>,
        request_digest: Vec<u8>,
        now: Instant,
    ) -> Result<AcceptResult, OperationError> {
        self.prune(now);
        let operation_id = operation_id.into();
        if let Some(record) = self.operations.get(&operation_id) {
            if record.request_digest != request_digest {
                return Err(OperationError::OperationIdConflict);
            }
            return Ok(AcceptResult::Duplicate(
                self.make_snapshot(&operation_id, record),
            ));
        }
        if self.operations.len() >= self.max_operations {
            return Err(OperationError::OperationLimit);
        }
        self.operations.insert(
            operation_id,
            OperationRecord {
                request_digest,
                state: OperationState::Accepted,
                next_sequence: 1,
                first_retained_sequence: 1,
                retained_bytes: 0,
                output: VecDeque::new(),
                terminal: None,
                expires_at: now + self.retention,
            },
        );
        Ok(AcceptResult::Accepted)
    }

    pub fn start(&mut self, operation_id: &str, now: Instant) -> Result<(), OperationError> {
        let record = self.record_mut(operation_id, now)?;
        if record.state.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        record.state = OperationState::Running;
        Ok(())
    }

    pub fn begin_cancel(
        &mut self,
        operation_id: &str,
        now: Instant,
    ) -> Result<bool, OperationError> {
        let record = self.record_mut(operation_id, now)?;
        if record.state.is_terminal() {
            return Ok(false);
        }
        record.state = OperationState::Cancelling;
        Ok(true)
    }

    pub fn append_output(
        &mut self,
        operation_id: &str,
        stream: OutputStream,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<u64, OperationError> {
        if bytes.len() > self.max_output_bytes {
            return Err(OperationError::OutputChunkLimit);
        }
        let max_output_bytes = self.max_output_bytes;
        let record = self.record_mut(operation_id, now)?;
        if record.state.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        let sequence = record.next_sequence;
        record.next_sequence += 1;
        record.retained_bytes += bytes.len();
        record.output.push_back(OutputChunk {
            sequence,
            stream,
            bytes,
        });
        while record.retained_bytes > max_output_bytes {
            let Some(oldest) = record.output.pop_front() else {
                break;
            };
            record.retained_bytes -= oldest.bytes.len();
            record.first_retained_sequence = oldest.sequence + 1;
        }
        Ok(sequence)
    }

    pub fn acknowledge(
        &mut self,
        operation_id: &str,
        acknowledged_sequence: u64,
        now: Instant,
    ) -> Result<(), OperationError> {
        let record = self.record_mut(operation_id, now)?;
        if acknowledged_sequence >= record.next_sequence {
            return Err(OperationError::InvalidAcknowledgement);
        }
        while record
            .output
            .front()
            .is_some_and(|chunk| chunk.sequence <= acknowledged_sequence)
        {
            let Some(chunk) = record.output.pop_front() else {
                break;
            };
            record.retained_bytes -= chunk.bytes.len();
            record.first_retained_sequence = chunk.sequence + 1;
        }
        Ok(())
    }

    pub fn complete(
        &mut self,
        operation_id: &str,
        state: OperationState,
        exit_code: Option<i32>,
        error_code: Option<String>,
        now: Instant,
    ) -> Result<(), OperationError> {
        if !state.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        let retention = self.retention;
        let record = self.record_mut(operation_id, now)?;
        if record.state.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        record.state = state;
        record.terminal = Some(TerminalResult {
            state,
            exit_code,
            error_code,
        });
        record.expires_at = now + retention;
        Ok(())
    }

    pub fn snapshot(
        &self,
        operation_id: &str,
        now: Instant,
    ) -> Result<OperationSnapshot, OperationError> {
        let record = self
            .operations
            .get(operation_id)
            .ok_or(OperationError::UnknownOperation)?;
        if record.expires_at <= now {
            return Err(OperationError::UnknownOperation);
        }
        Ok(self.make_snapshot(operation_id, record))
    }

    pub fn replay_from(
        &self,
        operation_id: &str,
        after_sequence: u64,
        now: Instant,
    ) -> Result<Vec<OutputChunk>, OperationError> {
        let record = self
            .operations
            .get(operation_id)
            .ok_or(OperationError::UnknownOperation)?;
        if record.expires_at <= now {
            return Err(OperationError::UnknownOperation);
        }
        if after_sequence + 1 < record.first_retained_sequence {
            return Err(OperationError::ReplayGap {
                first_retained_sequence: record.first_retained_sequence,
            });
        }
        Ok(record
            .output
            .iter()
            .filter(|chunk| chunk.sequence > after_sequence)
            .cloned()
            .collect())
    }

    pub fn prune(&mut self, now: Instant) {
        self.operations.retain(|_, record| record.expires_at > now);
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

    pub fn restore_journal_record(
        &mut self,
        record: JournalRecord,
        now: Instant,
    ) -> Result<(), OperationError> {
        match record {
            JournalRecord::Accepted {
                operation_id,
                request_digest,
            } => match self.accept(operation_id, request_digest, now)? {
                AcceptResult::Accepted | AcceptResult::Duplicate(_) => Ok(()),
            },
            JournalRecord::Started { operation_id } => self.start(&operation_id, now),
            JournalRecord::Output {
                operation_id,
                sequence,
                stream,
                bytes,
            } => {
                let max_output_bytes = self.max_output_bytes;
                let record = self.record_mut(&operation_id, now)?;
                if record.next_sequence != sequence {
                    return Err(OperationError::JournalCorrupt);
                }
                if bytes.len() > max_output_bytes || record.state.is_terminal() {
                    return Err(OperationError::JournalCorrupt);
                }
                record.next_sequence += 1;
                record.retained_bytes += bytes.len();
                record.output.push_back(OutputChunk {
                    sequence,
                    stream,
                    bytes,
                });
                while record.retained_bytes > max_output_bytes {
                    let Some(oldest) = record.output.pop_front() else {
                        break;
                    };
                    record.retained_bytes -= oldest.bytes.len();
                    record.first_retained_sequence = oldest.sequence + 1;
                }
                Ok(())
            }
            JournalRecord::Acknowledged {
                operation_id,
                acknowledged_sequence,
            } => self.acknowledge(&operation_id, acknowledged_sequence, now),
            JournalRecord::OutputWatermark {
                operation_id,
                next_sequence,
                first_retained_sequence,
            } => self.restore_output_watermark(
                &operation_id,
                next_sequence,
                first_retained_sequence,
                now,
            ),
            JournalRecord::Retention {
                operation_id,
                expires_at_unix_ms,
            } => self.restore_retention(&operation_id, expires_at_unix_ms, now),
            JournalRecord::Completed {
                operation_id,
                state,
                exit_code,
                error_code,
            } => self.complete(&operation_id, state, exit_code, error_code, now),
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

    fn restore_output_watermark(
        &mut self,
        operation_id: &str,
        next_sequence: u64,
        first_retained_sequence: u64,
        now: Instant,
    ) -> Result<(), OperationError> {
        if next_sequence == 0
            || first_retained_sequence == 0
            || first_retained_sequence > next_sequence
        {
            return Err(OperationError::JournalCorrupt);
        }
        let record = self.record_mut(operation_id, now)?;
        if !record.output.is_empty() || record.next_sequence > 1 {
            return Err(OperationError::JournalCorrupt);
        }
        record.next_sequence = next_sequence;
        record.first_retained_sequence = first_retained_sequence;
        Ok(())
    }

    fn restore_retention(
        &mut self,
        operation_id: &str,
        expires_at_unix_ms: u64,
        now: Instant,
    ) -> Result<(), OperationError> {
        let current_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| OperationError::JournalCorrupt)?
            .as_millis() as u64;
        if expires_at_unix_ms <= current_unix_ms {
            self.operations.remove(operation_id);
            return Ok(());
        }
        let remaining = Duration::from_millis(expires_at_unix_ms - current_unix_ms);
        let record = self
            .operations
            .get_mut(operation_id)
            .ok_or(OperationError::UnknownOperation)?;
        record.expires_at = now + remaining;
        Ok(())
    }

    fn record_mut(
        &mut self,
        operation_id: &str,
        now: Instant,
    ) -> Result<&mut OperationRecord, OperationError> {
        self.prune(now);
        self.operations
            .get_mut(operation_id)
            .ok_or(OperationError::UnknownOperation)
    }

    fn make_snapshot(&self, operation_id: &str, record: &OperationRecord) -> OperationSnapshot {
        OperationSnapshot {
            operation_id: operation_id.to_owned(),
            state: record.state,
            next_sequence: record.next_sequence,
            first_retained_sequence: record.first_retained_sequence,
            terminal: record.terminal.clone(),
        }
    }
}
