use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static NEXT_PATH_ID: AtomicU64 = AtomicU64::new(0);

fn temp_path() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        ^ u128::from(NEXT_PATH_ID.fetch_add(1, Ordering::Relaxed));
    std::env::temp_dir().join(format!("bigbud-operation-compact-{suffix}.bin"))
}

fn unix_ms_in(seconds: u64) -> u64 {
    unix_now_ms().unwrap() + seconds * 1_000
}

fn append_operation(
    journal: &OperationJournal,
    operation_id: &str,
    output_bytes: usize,
    completed_expires_at: Option<u64>,
) {
    let id = operation_id.to_owned();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: id.clone(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Retention {
            operation_id: id.clone(),
            expires_at_unix_ms: unix_ms_in(24 * 60 * 60),
        })
        .unwrap();
    journal
        .append(&JournalRecord::Started {
            operation_id: id.clone(),
        })
        .unwrap();
    journal
        .append(&JournalRecord::Output {
            operation_id: id.clone(),
            sequence: 1,
            stream: OutputStream::Stdout,
            bytes: vec![b'x'; output_bytes],
        })
        .unwrap();
    if let Some(expires_at_unix_ms) = completed_expires_at {
        journal
            .append(&JournalRecord::Completed {
                operation_id: id.clone(),
                state: OperationState::Failed,
                exit_code: Some(7),
                error_code: Some("NONZERO_EXIT".to_owned()),
            })
            .unwrap();
        journal
            .append(&JournalRecord::Retention {
                operation_id: id,
                expires_at_unix_ms,
            })
            .unwrap();
    }
}

fn has_output(records: &[JournalRecord], operation_id: &str) -> bool {
    records.iter().any(|record| {
        matches!(record, JournalRecord::Output { operation_id: id, .. } if id == operation_id)
    })
}

#[test]
fn pressure_relief_drops_the_oldest_completed_output_and_keeps_its_result() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 4_096).unwrap();
    append_operation(&journal, "older", 700, Some(unix_ms_in(60)));
    append_operation(&journal, "newer", 700, Some(unix_ms_in(120)));
    append_operation(&journal, "running", 700, None);

    journal.compact().unwrap();
    let records = journal.records().unwrap();

    assert!(!has_output(&records, "older"));
    assert!(has_output(&records, "newer"));
    assert!(has_output(&records, "running"));
    assert!(records.iter().any(|record| matches!(
        record,
        JournalRecord::OutputWatermark {
            operation_id,
            next_sequence: 2,
            first_retained_sequence: 2,
        } if operation_id == "older"
    )));
    assert!(records.iter().any(|record| matches!(
        record,
        JournalRecord::Completed {
            operation_id,
            exit_code: Some(7),
            ..
        } if operation_id == "older"
    )));
    assert!(fs::metadata(&path).unwrap().len() <= 2_048);
    let _ = fs::remove_file(path);
}

#[test]
fn pressure_relief_never_drops_running_output() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 4_096).unwrap();
    append_operation(&journal, "running-1", 1_200, None);
    append_operation(&journal, "running-2", 1_200, None);

    journal.compact().unwrap();
    let records = journal.records().unwrap();

    assert!(has_output(&records, "running-1"));
    assert!(has_output(&records, "running-2"));
    let _ = fs::remove_file(path);
}

#[test]
fn a_full_journal_relieves_pressure_instead_of_refusing_new_work() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    append_operation(&journal, "done-1", 1_500, Some(unix_ms_in(60)));
    append_operation(&journal, "done-2", 1_500, Some(unix_ms_in(120)));
    let journal = OperationJournal {
        path: path.clone(),
        maximum_bytes: fs::metadata(&path).unwrap().len() as usize + 8,
    };

    journal
        .append(&JournalRecord::Accepted {
            operation_id: "next".to_owned(),
            request_digest: vec![2],
        })
        .unwrap();
    let records = journal.records().unwrap();
    assert!(!has_output(&records, "done-1"));
    assert!(records.iter().any(|record| matches!(
        record,
        JournalRecord::Accepted { operation_id, .. } if operation_id == "next"
    )));
    let _ = fs::remove_file(path);
}
