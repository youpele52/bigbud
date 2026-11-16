use std::collections::HashSet;
use std::fs;
#[cfg(not(unix))]
use std::fs::File;
#[cfg(any(not(unix), test))]
use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom, Write};
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
#[cfg(unix)]
#[path = "journal/temporary.rs"]
mod temporary;
#[cfg(unix)]
use temporary::Guard as JournalGuard;

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
    Io(#[from] io::Error),
    #[error("operation journal is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("operation journal exceeded its {maximum} byte limit")]
    Full { maximum: usize },
    #[error("operation journal record is too large")]
    RecordTooLarge,
    #[error("operation journal compaction deferred: {0}")]
    CompactionDeferred(&'static str),
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
        #[cfg(not(unix))]
        if path.exists()
            && fs::symlink_metadata(&path)
                .map_err(OperationJournalError::Io)?
                .file_type()
                .is_symlink()
        {
            return Err(OperationJournalError::Corrupt("journal path is a symlink"));
        }
        let guard = JournalGuard::acquire(&path)?;
        #[cfg(unix)]
        let recovery = guard.inspect_temporaries(maximum_bytes)?;
        #[cfg(unix)]
        guard.require_current_for_recovery(&recovery)?;
        let mut file = guard.current(true)?;
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
            file.rewind().map_err(OperationJournalError::Io)?;
            file.read_exact(&mut magic)
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
        #[cfg(unix)]
        let validate_authority = recovery.has_candidates();
        #[cfg(not(unix))]
        let validate_authority = false;
        journal.records_under_guard(&guard, validate_authority)?;
        #[cfg(unix)]
        guard.recover(recovery)?;
        Ok(journal)
    }

    pub fn records(&self) -> Result<Vec<JournalRecord>, OperationJournalError> {
        let guard = JournalGuard::acquire(&self.path)?;
        #[cfg(unix)]
        let validate_authority = guard
            .inspect_temporaries(self.maximum_bytes)?
            .has_candidates();
        #[cfg(not(unix))]
        let validate_authority = false;
        self.records_under_guard(&guard, validate_authority)
    }

    fn records_under_guard(
        &self,
        guard: &JournalGuard,
        validate_authority: bool,
    ) -> Result<Vec<JournalRecord>, OperationJournalError> {
        let mut file = guard.current(false)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take((self.maximum_bytes as u64).saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(OperationJournalError::Io)?;
        if bytes.len() > self.maximum_bytes {
            return Err(OperationJournalError::Full {
                maximum: self.maximum_bytes,
            });
        }
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
            return Err(OperationJournalError::Corrupt("invalid journal header"));
        }
        let (records, valid_length) = decode_complete_records(&bytes)?;
        if validate_authority {
            // Cleanup authority requires a valid complete prefix BEFORE any
            // tail repair. Keep ordinary no-candidate restore semantics intact.
            let _unmatched_history = inspect::validate_record_relationships(&records)?;
        }
        if valid_length != bytes.len() {
            file.set_len(valid_length as u64)
                .map_err(OperationJournalError::Io)?;
            file.sync_all().map_err(OperationJournalError::Io)?;
        }
        Ok(records)
    }

    pub fn append(&self, record: &JournalRecord) -> Result<(), OperationJournalError> {
        let guard = JournalGuard::acquire(&self.path)?;
        self.append_under_guard(record, &guard)
    }

    fn append_under_guard(
        &self,
        record: &JournalRecord,
        guard: &JournalGuard,
    ) -> Result<(), OperationJournalError> {
        let encoded = encode_record(record)?;
        let record_size = 4usize
            .checked_add(encoded.len())
            .ok_or(OperationJournalError::RecordTooLarge)?;
        let current_size = guard
            .current(false)?
            .metadata()
            .map_err(OperationJournalError::Io)?
            .len() as usize;
        if current_size
            .checked_add(record_size)
            .is_none_or(|size| size > self.maximum_bytes)
        {
            self.compact_under_guard(guard)?;
            let compacted_size = guard
                .current(false)?
                .metadata()
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
        let mut file = guard.current(false)?;
        file.seek(SeekFrom::End(0))
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

// This phase does not add cleanup or Unix locking claims on other platforms.
#[cfg(not(unix))]
struct JournalGuard {
    path: PathBuf,
}
#[cfg(not(unix))]
impl JournalGuard {
    fn acquire(path: &Path) -> Result<Self, OperationJournalError> {
        Ok(Self {
            path: path.to_owned(),
        })
    }
    fn current(&self, create: bool) -> Result<File, OperationJournalError> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .open(&self.path)
            .map_err(OperationJournalError::Io)
    }
}

#[cfg(test)]
#[path = "journal/tests.rs"]
mod tests;
