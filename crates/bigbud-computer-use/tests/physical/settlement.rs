//! Approved first-party dummy settlement cases: at most one leader plus one
//! same-group member, private 0700 roots, 10 s dummy self-deadlines.
#![allow(clippy::unwrap_used, clippy::panic)] // Private test fixtures only.
use super::support::{Dummy, Root, deadline, until};
use crate::worker::unix::{AnchoredGroup, BootstrapError, ClosureState, RetirementSignal};
use std::{fs, os::unix::process::ExitStatusExt, time::Instant};

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn natural_exit_closure_settles_then_settle_reaps_exact_leader() {
    let end = deadline();
    let root = Root::new();
    let child = Dummy::spawn(root.command("exit"));
    until(end, || root.0.join("ready").exists());
    assert_eq!(child.anchor().closure().unwrap(), ClosureState::LeaderLive);
    let recorded = child.anchor().root().clone();
    fs::write(root.0.join("exit"), b"ok").unwrap();
    until(end, || child.anchor().leader_exited().unwrap());
    assert_eq!(child.anchor().closure().unwrap(), ClosureState::Settled);
    // Zombie-only pinned group: "nothing live to signal" is not an error
    // (the review's sticky-unknown defect), and still not settlement.
    child.anchor().signal(RetirementSignal::Kill).unwrap();
    let settled = child.take().settle().unwrap();
    assert_eq!(settled.root(), &recorded);
    assert!(settled.status().success());
    assert!(Instant::now() < end);
}

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn surviving_member_blocks_settlement_until_exact_group_kill() {
    let end = deadline();
    let root = Root::new();
    let child = Dummy::spawn(root.command("helper"));
    until(end, || root.0.join("ready").exists());
    fs::write(root.0.join("exit"), b"ok").unwrap();
    until(end, || child.anchor().leader_exited().unwrap());
    // Leader exit is NOT closure settlement while a member remains.
    assert_eq!(
        child.anchor().closure().unwrap(),
        ClosureState::MembersRemain
    );
    let refused = child.take().settle().unwrap_err();
    assert_eq!(
        refused.anchor.closure().unwrap(),
        ClosureState::MembersRemain
    );
    let anchor = refused.anchor;
    // Pinned zombie leader keeps the PGID; KILL reaches the surviving member.
    anchor.signal(RetirementSignal::Kill).unwrap();
    until(end, || anchor.closure().unwrap() == ClosureState::Settled);
    let settled = anchor.settle().unwrap();
    assert!(settled.status().success());
    assert!(Instant::now() < end);
}

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn dropped_unsettled_owner_kills_its_exact_group_without_reaping() {
    let end = deadline();
    let root = Root::new();
    let child = Dummy::spawn(root.command("ignore-term"));
    until(end, || root.0.join("ready").exists());
    let pid = i32::try_from(child.anchor().root().pid.get()).unwrap();
    drop(child.take());
    // Test-only exact-PID reap of our own direct child after abandonment.
    let mut status = 0;
    until(end, || {
        // SAFETY: exact PID of this test's own unreaped direct child; WNOHANG
        // bounded polling with writable status storage. No wildcard wait.
        let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        assert!(reaped == 0 || reaped == pid, "exact dummy reap failed");
        reaped == pid
    });
    assert_eq!(
        std::process::ExitStatus::from_raw(status).signal(),
        Some(libc::SIGKILL)
    );
}

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn sigchld_auto_reap_disposition_refuses_anchor_spawn() {
    // Process-wide disposition change: refuse to run beside other cases.
    assert!(
        std::env::args().any(|arg| arg == "--test-threads=1"),
        "requires the documented serial --test-threads=1 invocation"
    );
    let root = Root::new();
    // SAFETY: zeroed output storage then a read of the current disposition.
    let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
    let mut ignore: libc::sigaction = unsafe { std::mem::zeroed() };
    ignore.sa_sigaction = libc::SIG_IGN;
    // SAFETY: valid signal/actions; serial explicit target, restored below.
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGCHLD, &ignore, &mut previous) },
        0
    );
    let result = AnchoredGroup::spawn_bootstrap(
        &mut root.command("term"),
        "dummy-1",
        &crate::worker::unix::LaunchGuard::acquire().unwrap(),
    );
    // SAFETY: restore the exact previous disposition before any assertion.
    let restored = unsafe { libc::sigaction(libc::SIGCHLD, &previous, std::ptr::null_mut()) };
    assert_eq!(restored, 0);
    match result {
        Err(BootstrapError::BeforeSpawn(_)) => {}
        Err(BootstrapError::Unsettled(_)) => panic!("child spawned under auto-reap"),
        Ok(_) => panic!("anchor accepted under auto-reap"),
    }
    assert!(!root.0.join("ready").exists());
}

#[test]
#[ignore = "approved dummy physical lifecycle only; explicit serial invocation"]
fn guard_service_shutdown_retires_settles_and_durably_removes_dummy_root() {
    use crate::guard::{
        ControllingLock, GuardServiceConfig, GuardServiceControl, GuardServiceExit,
        record::SafetyRecord,
    };
    let end = deadline();
    let root = Root::new();
    let state = root.0.join("state");
    std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700)
        .create(&state)
        .unwrap();
    let child = Dummy::spawn(root.command("term"));
    until(end, || root.0.join("ready").exists());
    let anchor = child.take();
    let mut elected = ControllingLock::acquire_in_verified_directory(&state).unwrap();
    let record = SafetyRecord {
        armed: true,
        roots: vec![anchor.root().clone()],
        ..SafetyRecord::initial()
    };
    elected.journal().replace(&record).unwrap();
    let mut recovery = elected.recover_retained();
    assert!(recovery.attach_retirement(vec![anchor]).is_ok());
    let control = GuardServiceControl::default();
    control.request_shutdown();
    let report = recovery.run_guard_service(&control, GuardServiceConfig::default());
    assert_eq!(report.exit, GuardServiceExit::ShutdownSettled);
    let status = report.status.unwrap();
    assert_eq!((status.term_sent, status.settled), (1, 1));
    assert!(report.storage_ok && !status.unknown);
    drop(recovery);
    let persisted = elected.journal().read().unwrap().unwrap();
    assert!(persisted.roots.is_empty() && persisted.latched);
    assert!(Instant::now() < end);
}
