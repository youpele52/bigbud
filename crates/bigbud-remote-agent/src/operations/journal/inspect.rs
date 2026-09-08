use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;

use super::recovery::decode_complete_records;
use super::{JournalRecord, MAGIC, MAX_OPERATION_JOURNAL_BYTES, OperationJournalError};

#[path = "inspect.relationships.rs"]
mod relationships;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

pub fn inspect_active_operations(path: &Path) -> Result<bool, OperationJournalError> {
    Ok(validate_journal_read_only(path)?.has_unmatched_acceptances)
}

/// Persisted history is not a proof of runtime liveness across a legacy restart.
pub struct JournalInspection {
    pub has_unmatched_acceptances: bool,
}

/// Validate complete persisted history without opening recovery or repairing its tail.
pub fn validate_journal_read_only(path: &Path) -> Result<JournalInspection, OperationJournalError> {
    let metadata = fs::symlink_metadata(path).map_err(OperationJournalError::Io)?;
    validate_metadata(&metadata)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(OperationJournalError::Io)?;
    let opened = file.metadata().map_err(OperationJournalError::Io)?;
    validate_metadata(&opened)?;
    #[cfg(unix)]
    if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
        return Err(OperationJournalError::Corrupt("journal identity changed"));
    }
    let records = read_complete_records(&file, opened.len())?;
    let after = file.metadata().map_err(OperationJournalError::Io)?;
    let current = fs::symlink_metadata(path).map_err(OperationJournalError::Io)?;
    validate_metadata(&current)?;
    #[cfg(unix)]
    if opened.dev() != current.dev()
        || opened.ino() != current.ino()
        || opened.mtime() != after.mtime()
        || opened.mtime_nsec() != after.mtime_nsec()
        || opened.ctime() != after.ctime()
        || opened.ctime_nsec() != after.ctime_nsec()
    {
        return Err(OperationJournalError::Corrupt(
            "journal changed during inspection",
        ));
    }
    if opened.len() != after.len() || opened.len() != current.len() {
        return Err(OperationJournalError::Corrupt(
            "journal length changed during inspection",
        ));
    }
    Ok(JournalInspection {
        has_unmatched_acceptances: relationships::validate(&records)?,
    })
}

fn validate_metadata(metadata: &fs::Metadata) -> Result<(), OperationJournalError> {
    if !metadata.file_type().is_file() {
        return Err(OperationJournalError::Corrupt(
            "journal path is not a regular file",
        ));
    }
    #[cfg(unix)]
    // SAFETY: geteuid has no arguments or memory safety preconditions.
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

    Ok(())
}

fn read_complete_records(
    file: &File,
    length: u64,
) -> Result<Vec<JournalRecord>, OperationJournalError> {
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_OPERATION_JOURNAL_BYTES as u64 + 1)
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

    // Recovery accepts historical encodings leniently. Inspection must not authorize
    // takeover for malformed option tags that decode to the same optional value.
    let mut offset = MAGIC.len();
    for record in &records {
        let encoded = super::codec::encode_record(record)?;
        offset += 4;
        if bytes.get(offset..offset + encoded.len()) != Some(encoded.as_slice()) {
            return Err(OperationJournalError::Corrupt(
                "noncanonical journal record",
            ));
        }
        offset += encoded.len();
    }
    Ok(records)
}

#[cfg(test)]
#[path = "inspect.tests.rs"]
mod tests;
