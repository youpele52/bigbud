#![allow(clippy::unwrap_used)] // Private test fixtures only.
mod dummy;
mod settlement;
mod support;
use crate::{
    guard::{ControllingLock, PriorityRetirement},
    owner::{IndependentLifeline, WatcherOutcome, private_bootstrap::dummy_fixture::DummyExchange},
    worker::unix::{RetirementSignal, inspect},
};
use std::{
    fs,
    os::unix::process::ExitStatusExt,
    thread,
    time::{Duration, Instant},
};
use support::{Dummy, Root, deadline, until};

#[test]
#[ignore = "first-party dummy entry only; explicit private parent fixture required"]
fn dummy_entry() {
    dummy::run();
}

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn term_and_repeated_nonreaping_leader_observation() {
    let end = deadline();
    let root = Root::new();
    let mut child = Dummy::spawn(root.command("term"));
    until(end, || root.0.join("ready").exists());
    assert!(!child.anchor().leader_exited().unwrap());
    let original = inspect(child.anchor().root().pid).unwrap();
    assert!(child.anchor_mut().reject_changed_dummy_identity().is_err());
    assert_eq!(child.anchor().dummy_signal_attempts(), 0);
    assert!(!child.anchor().leader_exited().unwrap());
    child.anchor().signal(RetirementSignal::Terminate).unwrap();
    until(end, || child.anchor().leader_exited().unwrap());
    assert!(child.anchor().leader_exited().unwrap());
    assert_eq!(child.anchor().root().creation_identity, original.creation);
    let attempts = child.anchor().dummy_signal_attempts();
    // A zombie-only group can return EPERM/ESRCH from killpg; neither is exit
    // proof or successful helper retirement. Production preserves that error.
    // The private counter distinguishes reaching the actual checked group signal
    // syscall after WNOWAIT from the original proc_pidinfo-before-wait defect.
    let signal = child.anchor().signal(RetirementSignal::Kill);
    assert_eq!(child.anchor().dummy_signal_attempts(), attempts + 1);
    if let Err(error) = signal {
        assert!(
            matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM)),
            "post-exit native group signal: {error:?}"
        );
    }
    assert!(child.anchor().leader_exited().unwrap());
    let result = child.reap().unwrap();
    assert_eq!(result.signal(), Some(libc::SIGTERM));
    assert!(Instant::now() < end);
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn ignored_term_then_exact_group_kill() {
    let end = deadline();
    let root = Root::new();
    let child = Dummy::spawn(root.command("ignore-term"));
    until(end, || root.0.join("ready").exists());
    child.anchor().signal(RetirementSignal::Terminate).unwrap();
    let quiet_end = Instant::now() + Duration::from_millis(100);
    while Instant::now() < quiet_end {
        assert!(!child.anchor().leader_exited().unwrap());
        thread::sleep(Duration::from_millis(5));
    }
    child.anchor().signal(RetirementSignal::Kill).unwrap();
    until(end, || child.anchor().leader_exited().unwrap());
    assert_eq!(child.reap().unwrap().signal(), Some(libc::SIGKILL));
    assert!(Instant::now() < end);
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn natural_exit_is_nonreaping_not_production_closure_settlement() {
    let end = deadline();
    let root = Root::new();
    let child = Dummy::spawn(root.command("exit"));
    until(end, || root.0.join("ready").exists());
    let original = child.anchor().root().clone();
    fs::write(root.0.join("exit"), b"exit").unwrap();
    until(end, || child.anchor().leader_exited().unwrap());
    assert!(child.anchor().leader_exited().unwrap());
    assert_eq!(child.anchor().root(), &original);
    assert_eq!(
        child.anchor().root().creation_identity,
        original.creation_identity
    );
    assert!(child.reap().unwrap().success());
}
fn connected(root: &Root, end: Instant) -> (Dummy, crate::owner::AuthenticatedPeer) {
    let (exchange, stdin) = DummyExchange::prepare(end).unwrap();
    let mut command = root.command("bootstrap");
    command.stdin(stdin);
    let child = Dummy::spawn(command);
    let peer = exchange
        .authenticate(child.anchor().root().clone())
        .unwrap();
    assert_eq!(peer.execution_root(), child.anchor().root());
    until(end, || root.0.join("courier-closed").exists());
    (child, peer)
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn inherited_once_postexec_auth_and_worker_death_revoke_independent_lifeline() {
    let end = deadline();
    let root = Root::new();
    let (child, peer) = connected(&root, end);
    let requests = PriorityRetirement::default();
    let watcher = IndependentLifeline::start(peer, requests.clone()).unwrap();
    child.anchor().signal(RetirementSignal::Kill).unwrap();
    let mut causes = 0;
    until(end, || {
        causes |= requests.take_causes();
        causes & crate::guard::RetirementCause::WorkerLost as u8 != 0
    });
    assert!(requests.admission_closed());
    assert_eq!(causes, crate::guard::RetirementCause::WorkerLost as u8);
    match watcher.stop_and_join(Duration::from_secs(1)) {
        Ok(outcome) => assert_eq!(outcome, WatcherOutcome::ParentLost),
        Err(retained) => {
            // Retain the exact failed-join handle during one final bounded
            // teardown attempt; never silently discard an unsettled watcher.
            let joined = retained.stop_and_join(Duration::from_secs(1));
            assert!(joined.is_ok(), "dummy watcher cleanup failed");
            panic!("dummy watcher missed initial join budget");
        }
    }
    assert_eq!(child.reap().unwrap().signal(), Some(libc::SIGKILL));
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn verified_parent_endpoint_loss_is_visible_after_courier_closure() {
    let end = deadline();
    let root = Root::new();
    let (child, peer) = connected(&root, end);
    drop(peer);
    until(end, || child.anchor().leader_exited().unwrap());
    assert!(root.0.join("parent-eof").exists());
    assert!(child.reap().unwrap().success());
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn cross_process_election_conflict_then_release() {
    let end = deadline();
    let root = Root::new();
    let lock = ControllingLock::acquire_in_verified_directory(&root.0).unwrap();
    let child = Dummy::spawn(root.command("election-conflict"));
    until(end, || child.anchor().leader_exited().unwrap());
    assert!(child.reap().unwrap().success());
    assert!(root.0.join("conflict").exists());
    drop(lock);
    let child = Dummy::spawn(root.command("election-acquire"));
    until(end, || child.anchor().leader_exited().unwrap());
    assert!(child.reap().unwrap().success());
    assert!(root.0.join("elected").exists());
}
#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn assertion_unwind_kills_and_reaps_only_retained_dummy() {
    let root = Root::new();
    let end = deadline();
    let child = Dummy::spawn(root.command("ignore-term"));
    until(end, || root.0.join("ready").exists());
    let cleaned = child.cleaned.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _retained = child;
        panic!("intentional dummy assertion failure");
    }));
    assert!(result.is_err());
    assert_eq!(*cleaned.lock().unwrap(), Some(true));
    assert!(Instant::now() < end);
}
