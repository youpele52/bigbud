use super::*;

impl OperationRegistry {
    /// Non-terminal work never expires, so any of it keeps the agent busy.
    pub fn has_live_operations(&self) -> bool {
        self.operations
            .values()
            .any(|record| !record.state.is_terminal())
    }

    pub fn new(max_operations: usize, max_output_bytes: usize, retention: Duration) -> Self {
        Self {
            max_operations,
            max_output_bytes,
            retention,
            max_terminal_output_bytes: max_output_bytes.saturating_mul(max_operations),
            operations: HashMap::new(),
        }
    }

    /// Bounds the output bytes kept for terminal operations in total. Beyond
    /// it, the oldest terminal results lose their output but keep their state
    /// and exit code, so an attach reports a replay gap instead of nothing.
    pub fn with_terminal_output_budget(mut self, bytes: usize) -> Self {
        self.max_terminal_output_bytes = bytes;
        self
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
        if self.operations.len() >= self.max_operations && !self.evict_oldest_terminal() {
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
        self.enforce_terminal_output_budget();
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
        if record.is_expired(now) {
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
        if record.is_expired(now) {
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

    pub(super) fn record_mut(
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
