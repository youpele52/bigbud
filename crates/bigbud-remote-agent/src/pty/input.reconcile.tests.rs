use super::*;
use std::sync::atomic::AtomicUsize;

#[test]
fn retirement_wins_and_all_late_frames_remain_non_executing() {
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = Arc::clone(&calls);
    let writer = InputWriter::start(b"retired".to_vec(), move |bytes| {
        copy.fetch_add(1, Ordering::SeqCst);
        Ok(bytes.len())
    })
    .unwrap();
    let digest = payload_digest(b"late");
    let first = writer.reconcile(1, digest, 4, true).unwrap();
    assert_eq!(first.outcome, InputOutcome::NotAdmitted);
    assert_eq!(writer.reconcile(1, digest, 4, true).unwrap(), first);
    assert!(writer.submit(1, b"late").is_err());
    assert!(writer.submit(1, b"different").is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    writer.submit(2, b"new").unwrap();
    assert_eq!(writer.wait(2).unwrap(), InputOutcome::Written(3));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(writer.reconcile(1, digest, 4, true).is_err());
    writer.shutdown().unwrap();
}

#[test]
fn admitted_inflight_input_cannot_be_replaced_by_a_zero_byte_receipt() {
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = Arc::clone(&calls);
    let writer = InputWriter::start(b"admitted".to_vec(), move |bytes| {
        copy.fetch_add(1, Ordering::SeqCst);
        entered.send(()).unwrap();
        wait.recv().unwrap();
        Ok(bytes.len())
    })
    .unwrap();
    writer.submit(1, b"once").unwrap();
    observed.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        writer
            .reconcile(1, payload_digest(b"once"), 4, true)
            .unwrap()
            .outcome,
        InputOutcome::Writing(0)
    );
    assert!(
        writer
            .reconcile(2, payload_digest(b"later"), 5, true)
            .is_err()
    );
    release.send(()).unwrap();
    assert_eq!(writer.wait(1).unwrap(), InputOutcome::Written(4));
    let receipt = writer
        .reconcile(1, payload_digest(b"once"), 4, true)
        .unwrap();
    assert_eq!(receipt.outcome, InputOutcome::Written(4));
    assert_eq!(
        writer
            .reconcile(1, payload_digest(b"once"), 4, true)
            .unwrap(),
        receipt
    );
    assert!(!writer.submit(1, b"once").unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    writer.shutdown().unwrap();
}

#[test]
fn full_write_receipt_does_not_clear_native_cancellation_or_fence() {
    let shared: Arc<Mutex<Option<Arc<Shared>>>> = Arc::new(Mutex::new(None));
    let copy = Arc::clone(&shared);
    let writer = InputWriter::start(b"cancel-after-syscall".to_vec(), move |bytes| {
        let state = copy.lock().unwrap().as_ref().unwrap().clone();
        state.cancelled.store(true, Ordering::Release);
        state.ledger.lock().unwrap().fenced = true;
        Ok(bytes.len())
    })
    .unwrap();
    *shared.lock().unwrap() = Some(Arc::clone(&writer.shared));
    writer.submit(1, b"full").unwrap();
    assert_eq!(writer.wait(1).unwrap(), InputOutcome::Written(4));
    let receipt = writer
        .reconcile(1, payload_digest(b"full"), 4, true)
        .unwrap();
    assert_eq!(receipt.outcome, InputOutcome::Written(4));
    assert!(!receipt.writer_usable);
    assert!(writer.submit(2, b"no").is_err());
    writer.shutdown().unwrap();
    *shared.lock().unwrap() = None;
}

#[test]
fn zero_and_partial_delivery_are_distinct_receipts() {
    let zero = InputWriter::start(b"zero".to_vec(), |_| Err(io::Error::other("zero"))).unwrap();
    zero.submit(1, b"bytes").unwrap();
    assert_eq!(zero.wait(1).unwrap(), InputOutcome::FailedBeforeWrite);
    assert_eq!(
        zero.reconcile(1, payload_digest(b"bytes"), 5, true)
            .unwrap()
            .outcome,
        InputOutcome::FailedBeforeWrite
    );
    zero.shutdown().unwrap();
    let mut calls = 0;
    let partial = InputWriter::start(b"partial".to_vec(), move |_| {
        calls += 1;
        if calls == 1 {
            Ok(2)
        } else {
            Err(io::Error::other("partial"))
        }
    })
    .unwrap();
    partial.submit(1, b"bytes").unwrap();
    assert_eq!(partial.wait(1).unwrap(), InputOutcome::PartialUnknown(2));
    let receipt = partial
        .reconcile(1, payload_digest(b"bytes"), 5, true)
        .unwrap();
    assert_eq!(receipt.outcome, InputOutcome::PartialUnknown(2));
    assert!(!receipt.writer_usable);
    assert!(
        partial
            .reconcile(2, payload_digest(b"new"), 3, true)
            .is_err()
    );
    partial.shutdown().unwrap();
}

#[test]
fn last_receipt_survives_expiry_and_pressure_without_reexecution() {
    let writer = InputWriter::start(b"retention".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    for sequence in 1..=4200 {
        writer.submit(sequence, b"x").unwrap();
        writer.wait(sequence).unwrap();
    }
    {
        let mut ledger = writer.shared.ledger.lock().unwrap();
        assert!(ledger.records.len() <= 4096);
        for record in ledger.records.values_mut() {
            record.completed = Instant::now().checked_sub(RETENTION);
        }
        prune(&mut ledger, Instant::now());
        assert!(ledger.records.is_empty());
        observe(&mut ledger, 1, InputOutcome::FailedBeforeWrite);
    }
    assert_eq!(
        writer
            .reconcile(4200, payload_digest(b"x"), 1, true)
            .unwrap()
            .outcome,
        InputOutcome::Written(1)
    );
    assert!(
        writer
            .reconcile(4199, payload_digest(b"x"), 1, true)
            .is_err()
    );
    assert!(writer.submit(4200, b"x").is_err());
    writer.submit(4201, b"x").unwrap();
    writer.wait(4201).unwrap();
    writer.shutdown().unwrap();
}

#[test]
fn tombstone_receipt_survives_expiry_and_still_refuses_late_input() {
    let writer = InputWriter::start(b"tombstone".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    writer
        .reconcile(1, payload_digest(b"never"), 5, true)
        .unwrap();
    {
        let mut ledger = writer.shared.ledger.lock().unwrap();
        ledger.records.get_mut(&1).unwrap().completed = Instant::now().checked_sub(RETENTION);
        prune(&mut ledger, Instant::now());
    }
    assert_eq!(
        writer
            .reconcile(1, payload_digest(b"never"), 5, true)
            .unwrap()
            .outcome,
        InputOutcome::NotAdmitted
    );
    assert!(writer.submit(1, b"never").is_err());
    writer.shutdown().unwrap();
}

#[test]
fn identity_conflicts_and_gap_or_draining_requests_do_not_mutate_admission() {
    let writer = InputWriter::start(b"identity".to_vec(), |bytes| Ok(bytes.len())).unwrap();
    assert!(writer.reconcile(3, payload_digest(b"x"), 1, true).is_err());
    assert!(writer.reconcile(1, payload_digest(b"x"), 1, false).is_err());
    assert_eq!(writer.shared.ledger.lock().unwrap().high_water, 0);
    writer.reconcile(1, payload_digest(b"x"), 1, true).unwrap();
    assert!(writer.reconcile(1, payload_digest(b"y"), 1, true).is_err());
    assert!(writer.reconcile(1, payload_digest(b"x"), 2, true).is_err());
    assert_eq!(writer.shared.ledger.lock().unwrap().high_water, 1);
    writer.shutdown().unwrap();
}
