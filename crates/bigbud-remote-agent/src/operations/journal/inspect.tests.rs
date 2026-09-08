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
    assert!(inspect_active_operations(&incomplete).is_err());

    let _ = fs::remove_file(corrupt);
    let _ = fs::remove_file(incomplete);
}
