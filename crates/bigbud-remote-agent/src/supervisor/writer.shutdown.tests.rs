#![allow(clippy::unwrap_used, clippy::panic)]
use super::*;
use std::process::Command;

const HELPER_ENV: &str = "BIGBUD_TEST_TERMINAL_WRITER_JOIN_BUDGET";

#[test]
fn several_unconfirmed_workers_share_budget_through_last_caller_release_and_cleanup_retries() {
    let module = module_path!()
        .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
        .unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("{module}::terminal_join_budget_helper"),
            "--nocapture",
        ])
        .env(HELPER_ENV, "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "join-budget subprocess failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn terminal_join_budget_helper() {
    if std::env::var_os(HELPER_ENV).is_none() {
        return;
    }
    let released = Arc::new((Mutex::new(false), Condvar::new()));
    let mut writers = Vec::new();
    let mut peers = Vec::new();
    for _ in 0..4 {
        let (socket, peer) = UnixStream::pair().unwrap();
        peers.push(peer);
        let completion = Arc::clone(&released);
        writers.push(
            OutboundWriter::start_worker(socket, false, move || {
                let (lock, changed) = &*completion;
                let released = lock.lock().unwrap();
                // Delay the entire worker's completion, AFTER native cancellation.
                // Even a prior completion notification must not count as a join.
                let _ = changed
                    .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
                    .unwrap();
            })
            .unwrap(),
        );
    }
    let weak = writers.iter().map(Arc::downgrade).collect::<Vec<_>>();
    assert!(super::super::job_lifecycle::seal());
    let began = Instant::now();
    let result = super::super::job_lifecycle::drain_all(Instant::now());
    assert!(result.is_err(), "delayed workers cannot be reported joined");
    assert!(
        writers
            .iter()
            .all(|writer| writer.is_closed() && !writer.worker_joined())
    );

    // Real connection-cleanup calls racing after the shared deadline must not
    // acquire independent 500 ms waits or hold worker locks while waiting.
    let cleanup = writers
        .iter()
        .cloned()
        .map(|writer| std::thread::spawn(move || assert!(writer.join().is_err())))
        .collect::<Vec<_>>();
    drop(writers); // Release all caller ownership while joins remain unknown.
    for cleanup in cleanup {
        cleanup.join().unwrap();
    }
    assert!(
        began.elapsed() < Duration::from_millis(800),
        "last-caller release or concurrent cleanup reset the terminal budget: {:?}",
        began.elapsed()
    );
    for weak in &weak {
        let retained = weak
            .upgrade()
            .expect("terminal owner must retain unknown worker");
        assert!(!retained.worker_joined());
        assert!(retained.join().is_err());
        drop(retained); // Repeated last-caller release cannot run a fresh join.
    }
    assert!(
        began.elapsed() < Duration::from_millis(800),
        "four unknown workers multiplied the terminal budget: {:?}",
        began.elapsed()
    );

    // The terminal owner kept the actual handles, not detached tasks. Once
    // completion is verified, expired-deadline cleanup may reap without wait.
    *released.0.lock().unwrap() = true;
    released.1.notify_all();
    let settle_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let joined = weak
            .iter()
            .all(|weak| weak.upgrade().unwrap().join().is_ok());
        if joined {
            break;
        }
        assert!(Instant::now() < settle_deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        weak.iter()
            .all(|weak| weak.upgrade().unwrap().worker_joined())
    );
    drop(peers);
}

#[test]
fn ordinary_nonterminal_explicit_join_still_waits_for_and_reaps_worker() {
    let (socket, _peer) = UnixStream::pair().unwrap();
    let writer = OutboundWriter::start_worker(socket, false, || {
        std::thread::sleep(Duration::from_millis(40));
    })
    .unwrap();
    let began = Instant::now();
    writer.join().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(35));
    assert!(began.elapsed() < Duration::from_millis(500));
    assert!(writer.is_closed() && writer.worker_joined());
}
