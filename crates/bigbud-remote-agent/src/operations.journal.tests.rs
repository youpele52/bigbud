use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

static NEXT_PATH_ID: AtomicU64 = AtomicU64::new(0);

fn temp_path() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        ^ u128::from(NEXT_PATH_ID.fetch_add(1, Ordering::Relaxed));
    std::env::temp_dir().join(format!("bigbud-operation-journal-{suffix}.bin"))
}

#[test]
fn round_trips_records_and_keeps_the_file_private() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    let records = vec![
        JournalRecord::Accepted {
            operation_id: "operation-1".to_owned(),
            request_digest: vec![1, 2, 3],
        },
        JournalRecord::Output {
            operation_id: "operation-1".to_owned(),
            sequence: 1,
            stream: OutputStream::Stdout,
            bytes: b"output".to_vec(),
        },
        JournalRecord::Retention {
            operation_id: "operation-1".to_owned(),
            expires_at_unix_ms: 1_900_000_000_000,
        },
        JournalRecord::Completed {
            operation_id: "operation-1".to_owned(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        },
    ];
    for record in &records {
        journal.append(record).unwrap();
    }
    assert_eq!(journal.records().unwrap(), records);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let _ = fs::remove_file(path);
}

#[test]
fn refuses_to_append_past_the_configured_bound() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 16).unwrap();
    let result = journal.append(&JournalRecord::Started {
        operation_id: "operation-1".to_owned(),
    });
    assert!(matches!(result, Err(OperationJournalError::Full { .. })));
    let _ = fs::remove_file(path);
}

#[test]
fn discards_an_incomplete_final_record_before_reopening() {
    let path = temp_path();
    let record = JournalRecord::Accepted {
        operation_id: "operation-1".to_owned(),
        request_digest: vec![1, 2, 3],
    };
    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    journal.append(&record).unwrap();
    let valid_length = fs::metadata(&path).unwrap().len();
    drop(journal);

    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&32_u32.to_be_bytes()).unwrap();
    file.write_all(b"partial").unwrap();
    file.sync_all().unwrap();
    drop(file);

    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    assert_eq!(journal.records().unwrap(), vec![record]);
    assert_eq!(fs::metadata(&path).unwrap().len(), valid_length);
    journal
        .append(&JournalRecord::Started {
            operation_id: "operation-1".to_owned(),
        })
        .unwrap();
    assert_eq!(journal.records().unwrap().len(), 2);
    let _ = fs::remove_file(path);
}

#[test]
fn compacts_acknowledged_output_without_resetting_sequence_ranges() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 256).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "operation-1".to_owned(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Started {
            operation_id: "operation-1".to_owned(),
        })
        .unwrap();
    for sequence in 1..=3 {
        journal
            .append(&JournalRecord::Output {
                operation_id: "operation-1".to_owned(),
                sequence,
                stream: OutputStream::Stdout,
                bytes: vec![sequence as u8; 32],
            })
            .unwrap();
        journal
            .append(&JournalRecord::Acknowledged {
                operation_id: "operation-1".to_owned(),
                acknowledged_sequence: sequence,
            })
            .unwrap();
    }
    journal
        .append(&JournalRecord::Output {
            operation_id: "operation-1".to_owned(),
            sequence: 4,
            stream: OutputStream::Stdout,
            bytes: b"retained".to_vec(),
        })
        .unwrap();
    journal.compact().unwrap();
    let records = journal.records().unwrap();
    assert!(records.iter().any(|record| matches!(
        record,
        JournalRecord::OutputWatermark {
            next_sequence: 5,
            first_retained_sequence: 4,
            ..
        }
    )));
    assert!(records.iter().any(|record| matches!(
        record,
        JournalRecord::Output {
            sequence: 4,
            bytes,
            ..
        } if bytes == b"retained"
    )));
    let _ = fs::remove_file(path);
}

#[test]
fn refuses_compaction_that_would_exceed_the_byte_bound() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "operation-1".to_owned(),
            request_digest: vec![1],
        })
        .unwrap();
    let original_length = fs::metadata(&path).unwrap().len();
    let bounded = OperationJournal {
        path: path.clone(),
        maximum_bytes: original_length as usize,
    };

    assert!(matches!(
        bounded.compact(),
        Err(OperationJournalError::Full { .. })
    ));
    assert_eq!(fs::metadata(&path).unwrap().len(), original_length);
    let _ = fs::remove_file(path);
}

#[test]
fn compaction_discards_expired_operations() {
    let path = temp_path();
    let journal = OperationJournal::open(&path, 1024 * 1024).unwrap();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: "operation-1".to_owned(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Retention {
            operation_id: "operation-1".to_owned(),
            expires_at_unix_ms: 1,
        })
        .unwrap();

    journal.compact().unwrap();
    assert!(journal.records().unwrap().is_empty());
    let _ = fs::remove_file(path);
}
