use super::*;
use std::sync::{Arc, mpsc};
use std::time::Duration;

#[test]
fn invalidates_authority_before_reap_and_never_signals_a_reused_numeric_id() {
    let child = Arc::new(Child::new(12345)); // Native calls replaced by deterministic seams.
    let (started, start) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let reaping = Arc::clone(&child);
    let worker = std::thread::spawn(move || {
        reaping.poll_with(|_| {
            started.send(()).map_err(io::Error::other)?;
            released.recv().map_err(io::Error::other)?;
            Ok(Some(Exit {
                code: Some(0),
                signal: None,
            }))
        })
    });
    start.recv_timeout(Duration::from_secs(1)).unwrap();
    let signalling = Arc::clone(&child);
    let signal = std::thread::spawn(move || {
        signalling.signal_with(|_| Err(io::Error::other("must not signal reused identity")))
    });
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    signal.join().unwrap().unwrap();
    child
        .signal_with(|_| Err(io::Error::other("retained exit must have no authority")))
        .unwrap();
}

#[test]
fn unexpected_wait_failure_stays_unknown_and_has_no_naked_signal_authority() {
    let child = Child::new(12345);
    assert!(
        child
            .poll_with(|_| Err(io::Error::other("injected wait failure")))
            .is_err()
    );
    assert!(!child.reaped());
    let mut called = false;
    assert!(
        child
            .signal_with(|_| {
                called = true;
                Ok(())
            })
            .is_err()
    );
    assert!(!called);
}
