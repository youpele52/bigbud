use super::*;
use crate::operations::OutputStream;
use crate::operations::journal::codec::append_encoded;

#[derive(Debug)]
enum Action {
    Open,
    Compact,
    Records,
}

fn accepted() -> JournalRecord {
    JournalRecord::Accepted {
        operation_id: "authority".into(),
        request_digest: vec![1],
    }
}

fn started() -> JournalRecord {
    JournalRecord::Started {
        operation_id: "authority".into(),
    }
}

fn output(sequence: u64) -> JournalRecord {
    JournalRecord::Output {
        operation_id: "authority".into(),
        sequence,
        stream: OutputStream::Stdout,
        bytes: b"retained".to_vec(),
    }
}

fn completed() -> JournalRecord {
    JournalRecord::Completed {
        operation_id: "authority".into(),
        state: OperationState::Completed,
        exit_code: Some(0),
        error_code: None,
    }
}

fn encoded(records: &[JournalRecord], partial_tail: bool) -> Vec<u8> {
    let mut chunks = vec![MAGIC.to_vec()];
    for record in records {
        append_encoded(&mut chunks, record).unwrap();
    }
    if partial_tail {
        chunks.push(vec![0, 0]);
    }
    chunks.concat()
}

#[test]
fn invalid_current_relationships_preserve_every_candidate_and_current_byte() {
    let histories = [
        vec![started()],
        vec![output(1)],
        vec![completed()],
        vec![accepted(), accepted()],
        vec![accepted(), started(), output(2)],
    ];
    let dead = dead_pid();
    for records in histories {
        for partial_tail in [false, true] {
            for operation in [Action::Open, Action::Compact, Action::Records] {
                let fixture = Fixture::new();
                let journal = OperationJournal::open(fixture.path(), 4096).unwrap();
                let current = encoded(&records, partial_tail);
                fixture.write("operations.journal", &current);
                let candidates = [
                    (".operations.journal.compact".to_owned(), b"BB".to_vec()),
                    (
                        format!(".operations.journal.compact-{dead}-123"),
                        MAGIC.to_vec(),
                    ),
                ];
                for (name, bytes) in &candidates {
                    fixture.write(name, bytes);
                }
                let result = match operation {
                    Action::Open => OperationJournal::open(fixture.path(), 4096).map(|_| ()),
                    Action::Compact => journal.compact(),
                    Action::Records => journal.records().map(|_| ()),
                };
                assert!(
                    matches!(result, Err(OperationJournalError::Corrupt(_))),
                    "{operation:?}: {records:?}, partial={partial_tail}: {result:?}"
                );
                assert_eq!(fs::read(fixture.path()).unwrap(), current);
                for (name, bytes) in candidates {
                    assert_eq!(fs::read(fixture.0.join(name)).unwrap(), bytes);
                }
                assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 4);
            }
        }
    }
}

#[test]
fn valid_partial_tail_recovers_without_losing_completed_history() {
    let records = [accepted(), started(), output(1), completed()];
    for compact in [false, true] {
        let fixture = Fixture::new();
        let journal = OperationJournal::open(fixture.path(), 4096).unwrap();
        fixture.write("operations.journal", &encoded(&records, true));
        fixture.write(".operations.journal.compact", b"BB");
        if compact {
            journal.compact().unwrap();
        } else {
            OperationJournal::open(fixture.path(), 4096).unwrap();
        }
        assert!(!fixture.0.join(".operations.journal.compact").exists());
        let recovered = journal.records().unwrap();
        assert!(recovered.contains(&records[2]));
        assert!(recovered.contains(&records[3]));
        if !compact {
            assert_eq!(fs::read(fixture.path()).unwrap(), encoded(&records, false));
        }
    }
}

#[test]
fn no_candidate_keeps_existing_lenient_restore_behavior() {
    let fixture = Fixture::new();
    let records = [started()];
    fixture.write("operations.journal", &encoded(&records, true));
    let journal = OperationJournal::open(fixture.path(), 4096).unwrap();
    assert_eq!(journal.records().unwrap(), records);
    assert_eq!(fs::read(fixture.path()).unwrap(), encoded(&records, false));
}
