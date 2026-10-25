use super::*;
use std::sync::atomic::AtomicUsize;

#[test]
fn reservation_deduplicates_before_io_and_rejects_conflicting_bytes() {
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let copy = Arc::clone(&delivered);
    let writer = InputWriter::start(b"epoch/pty/generation".to_vec(), move |bytes| {
        copy.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    })
    .unwrap();
    assert!(writer.submit(1, b"first").unwrap());
    assert!(!writer.submit(1, b"first").unwrap());
    assert!(matches!(
        writer.submit(1, b"changed"),
        Err(super::super::PtyError::InputConflict)
    ));
    assert_eq!(writer.wait(1).unwrap(), InputOutcome::Written(5));
    assert_eq!(&*delivered.lock().unwrap(), b"first");
    writer.shutdown().unwrap();
}

#[test]
fn partial_failure_permanently_fences_all_later_reserved_input() {
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = Arc::clone(&calls);
    let writer = InputWriter::start(b"partial".to_vec(), move |_| {
        if copy.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(2)
        } else {
            Err(io::Error::other("injected partial failure"))
        }
    })
    .unwrap();
    writer.submit(1, b"abcdef").unwrap();
    // This race may admit before the fence, or reject after it. Neither emits bytes.
    let later = writer.submit(2, b"never");
    assert_eq!(writer.wait(1).unwrap(), InputOutcome::PartialUnknown(2));
    if later.is_ok() {
        assert_eq!(writer.wait(2).unwrap(), InputOutcome::FailedBeforeWrite);
    }
    assert!(matches!(
        writer.submit(3, b"never"),
        Err(super::super::PtyError::InputFenced)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    writer.shutdown().unwrap();
}

#[test]
fn expiry_compacts_to_a_floor_that_never_reexecutes() {
    let writer = InputWriter::start(b"expiry".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    writer.submit(1, b"old").unwrap();
    writer.wait(1).unwrap();
    writer
        .shared
        .ledger
        .lock()
        .unwrap()
        .records
        .get_mut(&1)
        .unwrap()
        .completed = Instant::now().checked_sub(RETENTION);
    assert!(matches!(
        writer.submit(1, b"old"),
        Err(super::super::PtyError::InputExpired)
    ));
    assert_eq!(writer.shared.ledger.lock().unwrap().expired_through, 1);
    writer.submit(2, b"new").unwrap();
    assert_eq!(writer.wait(2).unwrap(), InputOutcome::Written(3));
    writer.shutdown().unwrap();
}

#[test]
fn blocked_nonblocking_writer_cancels_and_joins_without_waiting_for_deadline() {
    let writer = InputWriter::start(b"blocked".to_vec(), |_| {
        Err(io::ErrorKind::WouldBlock.into())
    })
    .unwrap();
    writer.submit(1, b"pending").unwrap();
    let began = Instant::now();
    writer.shutdown().unwrap();
    assert!(began.elapsed() < Duration::from_millis(500));
    assert_eq!(writer.status(1).unwrap(), InputOutcome::FailedBeforeWrite);
    assert!(matches!(
        writer.submit(2, b"new"),
        Err(super::super::PtyError::InputFenced)
    ));
}

#[test]
fn interrupted_syscall_does_not_replay_an_already_written_prefix() {
    let calls = AtomicUsize::new(0);
    let writer = InputWriter::start(b"interrupted".to_vec(), move |bytes| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(io::ErrorKind::Interrupted.into())
        } else {
            Ok(bytes.len())
        }
    })
    .unwrap();
    writer.submit(1, b"once").unwrap();
    assert_eq!(writer.wait(1).unwrap(), InputOutcome::Written(4));
    writer.shutdown().unwrap();
}

#[test]
fn queued_work_deadline_is_measured_from_admission_not_worker_start() {
    assert!(reserve(&LEDGER_BYTES, ENTRY_COST));
    assert!(reserve(&INPUT_BYTES, 5));
    let work = Work {
        sequence: 1,
        bytes: b"never".to_vec(),
        deadline: Instant::now(),
    };
    let shared = Shared {
        ledger: Mutex::new(Ledger {
            records: BTreeMap::from([(
                1,
                Record {
                    digest: [0; 32],
                    outcome: InputOutcome::Accepted,
                    completed: None,
                },
            )]),
            high_water: 1,
            expired_through: 0,
            fenced: false,
            pending: 1,
            bytes: 5,
        }),
        changed: Condvar::new(),
        cancelled: AtomicBool::new(false),
        finished: AtomicBool::new(false),
    };
    let mut calls = 0;
    process(&shared, &work, &mut |bytes| {
        calls += 1;
        Ok(bytes.len())
    });
    assert_eq!(calls, 0);
    let ledger = shared.ledger.lock().unwrap();
    assert_eq!(
        ledger.records.get(&1).unwrap().outcome,
        InputOutcome::FailedBeforeWrite
    );
    assert_eq!(ledger.pending, 0);
    assert_eq!(ledger.bytes, 0);
}

#[test]
fn more_than_4096_completed_inputs_compact_without_stopping_healthy_legacy_input() {
    let writer = InputWriter::start(b"continuous".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    for sequence in 1..=4200 {
        writer.submit(sequence, b"x").unwrap();
        assert_eq!(writer.wait(sequence).unwrap(), InputOutcome::Written(1));
    }
    assert!(matches!(
        writer.submit(1, b"x"),
        Err(super::super::PtyError::InputExpired)
    ));
    assert!(!writer.submit(4200, b"x").unwrap());
    assert!(writer.shared.ledger.lock().unwrap().records.len() <= 4096);
    writer.shutdown().unwrap();
}

#[test]
fn another_writer_reclaims_expired_idle_ledgers_without_losing_the_floor() {
    let idle = InputWriter::start(b"idle".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    idle.submit(1, b"old").unwrap();
    idle.wait(1).unwrap();
    idle.shared
        .ledger
        .lock()
        .unwrap()
        .records
        .get_mut(&1)
        .unwrap()
        .completed = Instant::now().checked_sub(RETENTION);
    let active = InputWriter::start(b"active".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    active.submit(1, b"new").unwrap();
    active.wait(1).unwrap();
    let old = idle.shared.ledger.lock().unwrap();
    assert!(old.records.is_empty());
    assert_eq!(old.expired_through, 1);
    drop(old);
    assert!(matches!(
        idle.submit(1, b"old"),
        Err(super::super::PtyError::InputExpired)
    ));
    idle.shutdown().unwrap();
    active.shutdown().unwrap();
}

#[test]
fn final_native_write_is_written_even_if_it_crosses_deadline_and_cancellation() {
    for cancelled in [false, true] {
        assert!(reserve(&LEDGER_BYTES, ENTRY_COST));
        assert!(reserve(&INPUT_BYTES, 1));
        let shared = Shared {
            ledger: Mutex::new(Ledger {
                records: BTreeMap::from([(
                    1,
                    Record {
                        digest: [0; 32],
                        outcome: InputOutcome::Accepted,
                        completed: None,
                    },
                )]),
                high_water: 1,
                expired_through: 0,
                fenced: false,
                pending: 1,
                bytes: 1,
            }),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        };
        let work = Work {
            sequence: 1,
            bytes: vec![b'x'],
            deadline: Instant::now() + Duration::from_millis(10),
        };
        process(&shared, &work, &mut |bytes| {
            if cancelled {
                shared.cancelled.store(true, Ordering::Release);
            } else {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(bytes.len())
        });
        assert_eq!(
            shared
                .ledger
                .lock()
                .unwrap()
                .records
                .get(&1)
                .unwrap()
                .outcome,
            InputOutcome::Written(1)
        );
    }
}
