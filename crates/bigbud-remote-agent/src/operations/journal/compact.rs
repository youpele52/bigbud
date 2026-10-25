use std::collections::BTreeMap;

use super::codec::{CompactOperation, append_encoded};
use super::*;

/// When ordinary compaction leaves the journal above this share of its cap,
/// the output bytes of the oldest completed operations are dropped while
/// their acceptance, watermark, retention and completion records stay. A
/// day-long result can then never starve new work, and appends near the cap
/// do not rewrite the whole journal on every call.
fn pressure_relief_target(maximum_bytes: usize) -> usize {
    maximum_bytes / 2
}

impl OperationJournal {
    pub(super) fn compact(&self) -> Result<(), OperationJournalError> {
        let operations = fold_records(self.records()?);
        let current_unix_ms = unix_now_ms()?;
        let running = self.running_operations().clone();
        let mut encoded = Vec::new();
        for (operation_id, operation) in operations {
            // A running operation never expires; only its acceptance-time
            // retention record would say otherwise.
            let still_running =
                operation.completed.is_none() && running.contains(operation_id.as_str());
            if !still_running
                && operation
                    .expires_at_unix_ms
                    .is_some_and(|expires_at| expires_at <= current_unix_ms)
            {
                continue;
            }
            encoded.push(EncodedOperation::new(operation_id, operation)?);
        }
        relieve_pressure(
            &mut encoded,
            pressure_relief_target(self.maximum_bytes).saturating_sub(MAGIC.len()),
        );
        let mut compacted = vec![MAGIC.to_vec()];
        for operation in encoded {
            operation.write_to(&mut compacted);
        }
        let compacted_size = compacted
            .iter()
            .try_fold(0usize, |size, bytes| size.checked_add(bytes.len()))
            .ok_or(OperationJournalError::RecordTooLarge)?;
        if compacted_size > self.maximum_bytes {
            return Err(OperationJournalError::Full {
                maximum: self.maximum_bytes,
            });
        }
        self.replace_contents(&compacted)
    }

    fn replace_contents(&self, compacted: &[Vec<u8>]) -> Result<(), OperationJournalError> {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| OperationJournalError::Corrupt("clock is before Unix epoch"))?
            .as_nanos();
        let temporary = self.path.with_file_name(format!(
            ".{}.compact-{}-{}",
            self.path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("journal"),
            std::process::id(),
            suffix
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(OperationJournalError::Io)?;
        let result = (|| {
            for bytes in compacted {
                file.write_all(bytes).map_err(OperationJournalError::Io)?;
            }
            file.sync_all().map_err(OperationJournalError::Io)?;
            set_private_permissions(&temporary).map_err(OperationJournalError::Io)?;
            fs::rename(&temporary, &self.path).map_err(OperationJournalError::Io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn unix_now_ms() -> Result<u64, OperationJournalError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OperationJournalError::Corrupt("clock is before Unix epoch"))?
        .as_millis() as u64)
}

fn fold_records(records: Vec<JournalRecord>) -> BTreeMap<String, CompactOperation> {
    let mut operations = BTreeMap::<String, CompactOperation>::new();
    for record in records {
        match record {
            JournalRecord::Accepted {
                operation_id,
                request_digest,
            } => {
                operations.entry(operation_id).or_default().request_digest = Some(request_digest);
            }
            JournalRecord::Started { operation_id } => {
                operations.entry(operation_id).or_default().started = true;
            }
            JournalRecord::Output {
                operation_id,
                sequence,
                stream,
                bytes,
            } => {
                let operation = operations.entry(operation_id).or_default();
                operation.next_sequence = operation.next_sequence.max(sequence.saturating_add(1));
                operation.outputs.push((sequence, stream, bytes));
            }
            JournalRecord::Acknowledged {
                operation_id,
                acknowledged_sequence,
            } => {
                let operation = operations.entry(operation_id).or_default();
                operation.acknowledged_sequence =
                    operation.acknowledged_sequence.max(acknowledged_sequence);
                operation
                    .outputs
                    .retain(|(sequence, _, _)| *sequence > operation.acknowledged_sequence);
            }
            JournalRecord::OutputWatermark {
                operation_id,
                next_sequence,
                first_retained_sequence,
            } => {
                let operation = operations.entry(operation_id).or_default();
                operation.next_sequence = operation.next_sequence.max(next_sequence);
                operation.first_retained_sequence = operation
                    .first_retained_sequence
                    .max(first_retained_sequence);
            }
            JournalRecord::Retention {
                operation_id,
                expires_at_unix_ms,
            } => {
                operations
                    .entry(operation_id)
                    .or_default()
                    .expires_at_unix_ms = Some(expires_at_unix_ms);
            }
            JournalRecord::Completed {
                operation_id,
                state,
                exit_code,
                error_code,
            } => {
                operations.entry(operation_id).or_default().completed =
                    Some((state, exit_code, error_code));
            }
        }
    }
    operations
}

/// One operation's compacted records, pre-encoded so pressure relief can
/// account for their exact size before anything is written.
struct EncodedOperation {
    expires_at_unix_ms: Option<u64>,
    completed: bool,
    head: Vec<Vec<u8>>,
    watermark: Vec<Vec<u8>>,
    watermark_without_output: Vec<Vec<u8>>,
    retention: Vec<Vec<u8>>,
    outputs: Vec<Vec<u8>>,
    completion: Vec<Vec<u8>>,
    drop_output: bool,
}

impl EncodedOperation {
    fn new(
        operation_id: String,
        mut operation: CompactOperation,
    ) -> Result<Self, OperationJournalError> {
        let Some(request_digest) = operation.request_digest.take() else {
            return Err(OperationJournalError::Corrupt(
                "operation journal is missing an acceptance record",
            ));
        };
        let mut head = Vec::new();
        append_encoded(
            &mut head,
            &JournalRecord::Accepted {
                operation_id: operation_id.clone(),
                request_digest,
            },
        )?;
        if operation.started {
            append_encoded(
                &mut head,
                &JournalRecord::Started {
                    operation_id: operation_id.clone(),
                },
            )?;
        }
        operation.outputs.sort_by_key(|(sequence, _, _)| *sequence);
        let next_sequence = operation.next_sequence.max(
            operation
                .outputs
                .iter()
                .map(|(sequence, _, _)| sequence.saturating_add(1))
                .max()
                .unwrap_or(1),
        );
        let first_retained_sequence = operation
            .first_retained_sequence
            .max(operation.acknowledged_sequence.saturating_add(1))
            .min(next_sequence);
        let mut watermark = Vec::new();
        append_encoded(
            &mut watermark,
            &JournalRecord::OutputWatermark {
                operation_id: operation_id.clone(),
                next_sequence,
                first_retained_sequence,
            },
        )?;
        let mut watermark_without_output = Vec::new();
        append_encoded(
            &mut watermark_without_output,
            &JournalRecord::OutputWatermark {
                operation_id: operation_id.clone(),
                next_sequence,
                first_retained_sequence: next_sequence,
            },
        )?;
        let mut retention = Vec::new();
        if let Some(expires_at_unix_ms) = operation.expires_at_unix_ms {
            append_encoded(
                &mut retention,
                &JournalRecord::Retention {
                    operation_id: operation_id.clone(),
                    expires_at_unix_ms,
                },
            )?;
        }
        let mut outputs = Vec::new();
        for (sequence, stream, bytes) in operation.outputs {
            append_encoded(
                &mut outputs,
                &JournalRecord::Output {
                    operation_id: operation_id.clone(),
                    sequence,
                    stream,
                    bytes,
                },
            )?;
        }
        let completed = operation.completed.is_some();
        let mut completion = Vec::new();
        if let Some((state, exit_code, error_code)) = operation.completed {
            append_encoded(
                &mut completion,
                &JournalRecord::Completed {
                    operation_id,
                    state,
                    exit_code,
                    error_code,
                },
            )?;
        }
        Ok(Self {
            expires_at_unix_ms: operation.expires_at_unix_ms,
            completed,
            head,
            watermark,
            watermark_without_output,
            retention,
            outputs,
            completion,
            drop_output: false,
        })
    }

    fn size(&self) -> usize {
        let (watermark, outputs) = if self.drop_output {
            (&self.watermark_without_output, &[][..])
        } else {
            (&self.watermark, self.outputs.as_slice())
        };
        [
            self.head.as_slice(),
            watermark.as_slice(),
            self.retention.as_slice(),
            outputs,
            self.completion.as_slice(),
        ]
        .into_iter()
        .flatten()
        .map(Vec::len)
        .fold(0usize, usize::saturating_add)
    }

    fn write_to(self, compacted: &mut Vec<Vec<u8>>) {
        compacted.extend(self.head);
        if self.drop_output {
            compacted.extend(self.watermark_without_output);
            compacted.extend(self.retention);
        } else {
            compacted.extend(self.watermark);
            compacted.extend(self.retention);
            compacted.extend(self.outputs);
        }
        compacted.extend(self.completion);
    }
}

/// Drops the output of completed operations, the one expiring first first,
/// until the journal fits `target_bytes`. Running operations keep theirs.
fn relieve_pressure(operations: &mut [EncodedOperation], target_bytes: usize) {
    let mut total = operations
        .iter()
        .map(EncodedOperation::size)
        .fold(0usize, usize::saturating_add);
    if total <= target_bytes {
        return;
    }
    let mut candidates = operations
        .iter_mut()
        .filter(|operation| operation.completed && !operation.outputs.is_empty())
        .collect::<Vec<_>>();
    // Completed operations always carry a retention record; one without it
    // sorts last, which only keeps its output longer.
    candidates.sort_by_key(|operation| operation.expires_at_unix_ms.unwrap_or(u64::MAX));
    for operation in candidates {
        if total <= target_bytes {
            return;
        }
        let before = operation.size();
        operation.drop_output = true;
        total = total
            .saturating_sub(before)
            .saturating_add(operation.size());
    }
}

#[cfg(test)]
#[path = "compact.tests.rs"]
mod tests;
