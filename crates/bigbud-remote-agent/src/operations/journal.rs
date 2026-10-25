use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{OperationState, OutputStream};

#[path = "journal/codec.rs"]
mod codec;
#[path = "journal/compact.rs"]
mod compact;
#[path = "journal/inspect.rs"]
mod inspect;
#[path = "journal/recovery.rs"]
mod recovery;

pub use inspect::{JournalInspection, inspect_active_operations, validate_journal_read_only};

use codec::{decode_record, encode_record, set_private_permissions};
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
    /// Operations this process accepted and has not completed. Compaction never
    /// expires them: running operations never expire. One left behind by an
    /// earlier agent process was expired at restore (`AGENT_RESTARTED`) without
    /// a completion record, so its acceptance-time retention still applies.
    running: Mutex<HashSet<String>>,
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
            running: Mutex::new(HashSet::new()),
        };
        journal.records()?;
        Ok(journal)
    }

    pub fn records(&self) -> Result<Vec<JournalRecord>, OperationJournalError> {
        let mut file = File::open(&self.path).map_err(OperationJournalError::Io)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(OperationJournalError::Io)?;
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
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
        file.sync_all().map_err(OperationJournalError::Io)?;
        self.track_running(record);
        Ok(())
    }

    fn track_running(&self, record: &JournalRecord) {
        let mut running = self.running_operations();
        match record {
            JournalRecord::Accepted { operation_id, .. } => {
                running.insert(operation_id.clone());
            }
            JournalRecord::Completed { operation_id, .. } => {
                running.remove(operation_id);
            }
            _ => {}
        }
    }

    fn running_operations(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        // The set only widens what compaction keeps; a panic while it was held
        // cannot leave it in a state that would drop retained work.
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
#[path = "journal/tests.rs"]
mod tests;
