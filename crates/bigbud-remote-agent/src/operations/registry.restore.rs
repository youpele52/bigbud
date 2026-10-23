use super::*;

impl OperationRegistry {
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
}
