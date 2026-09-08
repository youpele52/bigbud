use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use super::recovery::decode_complete_records;
use super::{JournalRecord, MAGIC, MAX_OPERATION_JOURNAL_BYTES, OperationJournalError};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

pub fn inspect_active_operations(path: &Path) -> Result<bool, OperationJournalError> {
    let metadata = fs::symlink_metadata(path).map_err(OperationJournalError::Io)?;
    if !metadata.file_type().is_file() {
        return Err(OperationJournalError::Corrupt(
            "journal path is not a regular file",
        ));
    }
    #[cfg(unix)]
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(OperationJournalError::Corrupt(
            "journal ownership or permissions are invalid",
        ));
    }
    if metadata.len() > MAX_OPERATION_JOURNAL_BYTES as u64 {
        return Err(OperationJournalError::Full {
            maximum: MAX_OPERATION_JOURNAL_BYTES,
        });
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(OperationJournalError::Io)?
        .take(MAX_OPERATION_JOURNAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(OperationJournalError::Io)?;
    if bytes.len() > MAX_OPERATION_JOURNAL_BYTES {
        return Err(OperationJournalError::Full {
            maximum: MAX_OPERATION_JOURNAL_BYTES,
        });
    }
    if bytes.get(..MAGIC.len()) != Some(MAGIC) {
        return Err(OperationJournalError::Corrupt("invalid journal header"));
    }
    let (records, valid_length) = decode_complete_records(&bytes)?;
    if valid_length != bytes.len() {
        return Err(OperationJournalError::Corrupt(
            "incomplete final journal record",
        ));
    }

    let mut active = HashSet::new();
    for record in records {
        match record {
            JournalRecord::Accepted { operation_id, .. } => match active.insert(operation_id) {
                true => {}
                false => {
                    return Err(OperationJournalError::Corrupt(
                        "duplicate accepted operation",
                    ));
                }
            },
            JournalRecord::Completed {
                operation_id,
                state,
                ..
            } => match (state.is_terminal(), active.remove(&operation_id)) {
                (true, true) => {}
                _ => {
                    return Err(OperationJournalError::Corrupt(
                        "invalid completed operation",
                    ));
                }
            },
            _ => {}
        }
    }
    Ok(!active.is_empty())
}

#[cfg(test)]
#[path = "inspect.tests.rs"]
mod tests;
