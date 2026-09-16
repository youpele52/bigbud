use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;
use crate::operations::{OperationJournal, OperationState};

fn journal_path(label: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("bigbud-journal-inspect-{label}-{suffix}"))
}

#[test]
fn reports_nonterminal_operations_without_mutating_the_journal() {
    let path = journal_path("active");
    let journal = OperationJournal::open(&path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "accepted-before-spawn".to_owned(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Started {
            operation_id: "accepted-before-spawn".to_owned(),
        })
        .unwrap();

    let before = fs::read(&path).unwrap();
    assert!(inspect_active_operations(&path).unwrap());
    assert_eq!(fs::read(&path).unwrap(), before);

    journal
        .append(&JournalRecord::Completed {
            operation_id: "accepted-before-spawn".to_owned(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        })
        .unwrap();
    assert!(!inspect_active_operations(&path).unwrap());
    let _ = fs::remove_file(path);
}

#[test]
fn fails_closed_for_missing_corrupt_and_incomplete_journals() {
    let missing = journal_path("missing");
    assert!(inspect_active_operations(&missing).is_err());

    let corrupt = journal_path("corrupt");
    fs::write(&corrupt, b"not-a-journal").unwrap();
    assert!(inspect_active_operations(&corrupt).is_err());

    let incomplete = journal_path("incomplete");
    let journal = OperationJournal::open(&incomplete, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "pending".to_owned(),
            request_digest: vec![1],
        })
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(&incomplete)
        .unwrap()
        .write_all(&[0, 0])
        .unwrap();
    let before = fs::read(&incomplete).unwrap();
    assert!(inspect_active_operations(&incomplete).is_err());
    assert_eq!(fs::read(&incomplete).unwrap(), before);

    let _ = fs::remove_file(corrupt);
    let _ = fs::remove_file(incomplete);
}

#[test]
fn rejects_orphan_records_without_repairing_them() {
    for record in [
        JournalRecord::Started {
            operation_id: "unknown".into(),
        },
        JournalRecord::Output {
            operation_id: "unknown".into(),
            sequence: 1,
            stream: crate::operations::OutputStream::Stdout,
            bytes: vec![1],
        },
        JournalRecord::Acknowledged {
            operation_id: "unknown".into(),
            acknowledged_sequence: 0,
        },
        JournalRecord::Retention {
            operation_id: "unknown".into(),
            expires_at_unix_ms: 0,
        },
        JournalRecord::OutputWatermark {
            operation_id: "unknown".into(),
            next_sequence: 1,
            first_retained_sequence: 1,
        },
    ] {
        let path = journal_path("orphan");
        let journal = OperationJournal::open(&path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
        journal.append(&record).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(validate_journal_read_only(&path).is_err(), "{record:?}");
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn structural_validation_does_not_interpret_retention_as_runtime_liveness() {
    let path = journal_path("retention");
    let journal = OperationJournal::open(&path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "stale".into(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Retention {
            operation_id: "stale".into(),
            expires_at_unix_ms: 0,
        })
        .unwrap();
    let before = fs::read(&path).unwrap();
    assert!(
        validate_journal_read_only(&path)
            .unwrap()
            .has_unmatched_acceptances
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_file(path).unwrap();
}

#[test]
fn validates_compacted_output_followed_by_new_output() {
    let path = journal_path("watermark");
    let journal = OperationJournal::open(&path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    for record in [
        JournalRecord::Accepted {
            operation_id: "output".into(),
            request_digest: vec![1],
        },
        JournalRecord::Started {
            operation_id: "output".into(),
        },
        JournalRecord::OutputWatermark {
            operation_id: "output".into(),
            next_sequence: 4,
            first_retained_sequence: 3,
        },
        JournalRecord::Output {
            operation_id: "output".into(),
            sequence: 3,
            stream: crate::operations::OutputStream::Stdout,
            bytes: vec![1],
        },
        JournalRecord::Output {
            operation_id: "output".into(),
            sequence: 4,
            stream: crate::operations::OutputStream::Stdout,
            bytes: vec![2],
        },
        JournalRecord::Completed {
            operation_id: "output".into(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        },
        JournalRecord::Acknowledged {
            operation_id: "output".into(),
            acknowledged_sequence: 4,
        },
    ] {
        journal.append(&record).unwrap();
    }
    assert!(
        !validate_journal_read_only(&path)
            .unwrap()
            .has_unmatched_acceptances
    );
    fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_unsafe_permissions_and_oversized_files() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let path = journal_path("unsafe");
    let link = journal_path("symlink");
    OperationJournal::open(&path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    let before = fs::read(&path).unwrap();
    symlink(&path, &link).unwrap();
    assert!(validate_journal_read_only(&link).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(validate_journal_read_only(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_OPERATION_JOURNAL_BYTES as u64 + 1)
        .unwrap();
    assert!(matches!(
        validate_journal_read_only(&path),
        Err(OperationJournalError::Full { .. })
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        MAX_OPERATION_JOURNAL_BYTES as u64 + 1
    );
    fs::remove_file(link).unwrap();
    fs::remove_file(path).unwrap();
}
