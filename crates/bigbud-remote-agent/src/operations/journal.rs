use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{OperationState, OutputStream};

#[path = "journal/codec.rs"]
mod codec;
#[path = "journal/inspect.rs"]
mod inspect;
#[path = "journal/recovery.rs"]
mod recovery;

pub use inspect::inspect_active_operations;

use codec::{
    CompactOperation, append_encoded, decode_record, encode_record, set_private_permissions,
};
use recovery::decode_complete_records;

const MAGIC: &[u8] = b"BBRJ1";
const MAX_FIELD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OPERATION_JOURNAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalRecord {
    Accepted {
        operation_id: String,
        request_digest: Vec<u8>,
    },
    Started {
        operation_id: String,
    },
    Output {
        operation_id: String,
        sequence: u64,
        stream: OutputStream,
        bytes: Vec<u8>,
    },
    Acknowledged {
        operation_id: String,
        acknowledged_sequence: u64,
    },
    OutputWatermark {
        operation_id: String,
        next_sequence: u64,
        first_retained_sequence: u64,
    },
    Retention {
        operation_id: String,
        expires_at_unix_ms: u64,
    },
    Completed {
        operation_id: String,
        state: OperationState,
        exit_code: Option<i32>,
        error_code: Option<String>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum OperationJournalError {
    #[error("operation journal I/O failed: {0}")]
    Io(#[source] io::Error),
    #[error("operation journal is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("operation journal exceeded its {maximum} byte limit")]
    Full { maximum: usize },
    #[error("operation journal record is too large")]
    RecordTooLarge,
}

#[derive(Debug)]
pub struct OperationJournal {
    path: PathBuf,
    maximum_bytes: usize,
}

impl OperationJournal {
    pub fn open(
        path: impl AsRef<Path>,
        maximum_bytes: usize,
    ) -> Result<Self, OperationJournalError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(OperationJournalError::Io)?;
        }
        if path.exists()
            && fs::symlink_metadata(&path)
                .map_err(OperationJournalError::Io)?
                .file_type()
                .is_symlink()
        {
            return Err(OperationJournalError::Corrupt("journal path is a symlink"));
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(OperationJournalError::Io)?;
        let length = file.metadata().map_err(OperationJournalError::Io)?.len() as usize;
        if length == 0 {
            file.write_all(MAGIC).map_err(OperationJournalError::Io)?;
            file.sync_all().map_err(OperationJournalError::Io)?;
        } else if length > maximum_bytes {
            return Err(OperationJournalError::Full {
                maximum: maximum_bytes,
            });
        } else {
            let mut magic = [0; MAGIC.len()];
            let mut reader = File::open(&path).map_err(OperationJournalError::Io)?;
            reader
                .read_exact(&mut magic)
                .map_err(OperationJournalError::Io)?;
            if magic != MAGIC {
                return Err(OperationJournalError::Corrupt("invalid journal header"));
            }
        }
        set_private_permissions(&path).map_err(OperationJournalError::Io)?;
        let journal = Self {
            path,
            maximum_bytes,
        };
        journal.records()?;
        Ok(journal)
    }

    pub fn records(&self) -> Result<Vec<JournalRecord>, OperationJournalError> {
        let mut file = File::open(&self.path).map_err(OperationJournalError::Io)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(OperationJournalError::Io)?;
        if bytes.len() < MAGIC.len() || &bytes[..MAGIC.len()] != MAGIC {
            return Err(OperationJournalError::Corrupt("invalid journal header"));
        }
        let (records, valid_length) = decode_complete_records(&bytes)?;
        if valid_length != bytes.len() {
            let file = OpenOptions::new()
                .write(true)
                .open(&self.path)
                .map_err(OperationJournalError::Io)?;
            file.set_len(valid_length as u64)
                .map_err(OperationJournalError::Io)?;
            file.sync_all().map_err(OperationJournalError::Io)?;
        }
        Ok(records)
    }

    pub fn append(&self, record: &JournalRecord) -> Result<(), OperationJournalError> {
        let encoded = encode_record(record)?;
        let record_size = 4usize
            .checked_add(encoded.len())
            .ok_or(OperationJournalError::RecordTooLarge)?;
        let current_size = fs::metadata(&self.path)
            .map_err(OperationJournalError::Io)?
            .len() as usize;
        if current_size
            .checked_add(record_size)
            .is_none_or(|size| size > self.maximum_bytes)
        {
            self.compact()?;
            let compacted_size = fs::metadata(&self.path)
                .map_err(OperationJournalError::Io)?
                .len() as usize;
            if compacted_size
                .checked_add(record_size)
                .is_none_or(|size| size > self.maximum_bytes)
            {
                return Err(OperationJournalError::Full {
                    maximum: self.maximum_bytes,
                });
            }
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(OperationJournalError::Io)?;
        file.write_all(&(encoded.len() as u32).to_be_bytes())
            .map_err(OperationJournalError::Io)?;
        file.write_all(&encoded)
            .map_err(OperationJournalError::Io)?;
        file.sync_all().map_err(OperationJournalError::Io)
    }

    fn compact(&self) -> Result<(), OperationJournalError> {
        let records = self.records()?;
        let mut operations = BTreeMap::<String, CompactOperation>::new();
        for record in records {
            match record {
                JournalRecord::Accepted {
                    operation_id,
                    request_digest,
                } => {
                    operations.entry(operation_id).or_default().request_digest =
                        Some(request_digest);
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
                    operation.next_sequence =
                        operation.next_sequence.max(sequence.saturating_add(1));
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

        let current_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| OperationJournalError::Corrupt("clock is before Unix epoch"))?
            .as_millis() as u64;
        let mut compacted = vec![MAGIC.to_vec()];
        for (operation_id, mut operation) in operations {
            if operation
                .expires_at_unix_ms
                .is_some_and(|expires_at| expires_at <= current_unix_ms)
            {
                continue;
            }
            let Some(request_digest) = operation.request_digest.take() else {
                return Err(OperationJournalError::Corrupt(
                    "operation journal is missing an acceptance record",
                ));
            };
            append_encoded(
                &mut compacted,
                &JournalRecord::Accepted {
                    operation_id: operation_id.clone(),
                    request_digest,
                },
            )?;
            if operation.started {
                append_encoded(
                    &mut compacted,
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
            append_encoded(
                &mut compacted,
                &JournalRecord::OutputWatermark {
                    operation_id: operation_id.clone(),
                    next_sequence,
                    first_retained_sequence,
                },
            )?;
            if let Some(expires_at_unix_ms) = operation.expires_at_unix_ms {
                append_encoded(
                    &mut compacted,
                    &JournalRecord::Retention {
                        operation_id: operation_id.clone(),
                        expires_at_unix_ms,
                    },
                )?;
            }
            for (sequence, stream, bytes) in operation.outputs {
                append_encoded(
                    &mut compacted,
                    &JournalRecord::Output {
                        operation_id: operation_id.clone(),
                        sequence,
                        stream,
                        bytes,
                    },
                )?;
            }
            if let Some((state, exit_code, error_code)) = operation.completed {
                append_encoded(
                    &mut compacted,
                    &JournalRecord::Completed {
                        operation_id,
                        state,
                        exit_code,
                        error_code,
                    },
                )?;
            }
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
            for bytes in &compacted {
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

#[cfg(test)]
#[path = "journal/tests.rs"]
mod tests;
