use super::*;
use crate::guard::{SessionInvalidationCause, record::MAX_ROOTS};
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
fn session_notification_drained_before_attach_still_retires_and_flushes_on_signal_error() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let events = recovery.session_invalidator();
    events.invalidate(SessionInvalidationCause::Locked);
    assert_ne!(events.retirement_requests().take_causes(), 0);
    let calls = attach(&mut recovery);
    calls[0].lock().unwrap().fail_term = true;
    let before = recovery.record().unwrap().clone();
    assert!(step(&mut recovery, 100).unknown);
    assert!(matches!(
        recovery.flush_retirement_invalidation(),
        Err(RecoveryFailure::SessionInvalidated(
            SessionInvalidationCause::Locked
        ))
    ));
    let after = recovery.record().unwrap().clone();
    assert_eq!(after.pause_epoch, before.pause_epoch + 1);
    assert_eq!(after.roots, before.roots);
    assert_eq!(after.reason, "session_locked");
    assert!(after.armed && after.latched && after.input_uncertain);
    events.invalidate(SessionInvalidationCause::DesktopLost);
    let status = step(&mut recovery, 250_000_100);
    assert_eq!(status.kill_sent, 1);
    assert!(status.unknown);
    assert!(recovery.flush_retirement_invalidation().is_err());
    assert_eq!(recovery.record(), Some(&after));
    drop(recovery);
    assert_eq!(lock.journal().read().unwrap(), Some(after));
}

#[test]
fn storage_failure_is_sticky_but_cannot_suppress_signal_or_later_escalation() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    let roots = recovery.record().unwrap().roots.clone();
    recovery
        .session
        .retirement_requests()
        .raise(RetirementCause::OwnerLost);
    assert_eq!(step(&mut recovery, 0).term_sent, 1);
    let path = directory.0.join("safety.v1");
    let bytes = fs::read(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(matches!(
        recovery.flush_retirement_invalidation(),
        Err(RecoveryFailure::Read(_))
    ));
    assert_eq!(step(&mut recovery, 250_000_000).kill_sent, 1);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(
        recovery.flush_retirement_invalidation(),
        Err(RecoveryFailure::Read(_))
    ));
    assert!(step(&mut recovery, 2_000_000_000).unknown);
    assert_eq!(recovery.record().unwrap().roots, roots);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
}

#[test]
fn changed_storage_attachment_is_refused_without_repair_or_root_loss() {
    use std::io::{Seek, Write};
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let before = recovery.record().unwrap().clone();
    let path = directory.0.join("safety.v1");
    let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.rewind().unwrap();
    file.write_all(b"invalid").unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(matches!(
        recovery.check_retirement_targets(before.roots.iter()),
        Err(AttachRetirementFailure::Storage)
    ));
    assert!(matches!(recovery.failure(), Some(RecoveryFailure::Read(_))));
    assert!(recovery.retirement.is_none());
    assert_eq!(recovery.record().unwrap().roots, before.roots);
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn maximum_reserved_roots_and_wrong_order_are_checked_without_data_queue() {
    let directory = TestDirectory::new();
    let mut record = armed();
    let first = record.roots[0].clone();
    record.roots = (0..MAX_ROOTS)
        .map(|index| ExecutionRoot {
            pid: std::num::NonZeroU32::new(42 + index as u32).unwrap(),
            ..first.clone()
        })
        .collect();
    let mut lock = lock(&directory, record);
    let mut recovery = lock.recover_retained();
    let mut reversed = recovery.record().unwrap().roots.clone();
    reversed.reverse();
    assert!(matches!(
        recovery.check_retirement_targets(reversed.iter()),
        Err(AttachRetirementFailure::RootMismatch)
    ));
    let calls = attach(&mut recovery);
    recovery
        .session
        .retirement_requests()
        .raise(RetirementCause::WorkerLost);
    assert_eq!(step(&mut recovery, 1).term_sent, u8::MAX);
    assert_eq!(step(&mut recovery, 250_000_001).kill_sent, u8::MAX);
    for calls in calls {
        assert_eq!(signals(&calls), ["TERM", "KILL"]);
    }
    assert_eq!(recovery.record().unwrap().roots.len(), MAX_ROOTS);
}

#[test]
fn authenticated_same_process_lifeline_feeds_actual_service_channel_and_joins() {
    use crate::{
        Role,
        owner::{BootstrapCapability, IndependentLifeline, WatcherOutcome},
    };
    use std::{
        io::Write,
        os::unix::net::UnixStream,
        time::{Duration, Instant},
    };
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    let pid = std::num::NonZeroU32::new(std::process::id()).unwrap();
    let root = ExecutionRoot {
        pid,
        creation_identity: crate::worker::unix::inspect(pid).unwrap().creation,
        generation: "same-process-owner".into(),
    };
    let (mut capability, token) = BootstrapCapability::issue(root, Role::Owner).unwrap();
    let (mut writer, reader) = UnixStream::pair().unwrap();
    writer.write_all(&34_u32.to_be_bytes()).unwrap();
    writer.write_all(&[1, 2]).unwrap();
    writer.write_all(&token).unwrap();
    let peer = capability.authenticate_stream(reader).unwrap();
    let watcher = IndependentLifeline::start(peer, recovery.session.retirement_requests()).unwrap();
    drop(writer);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut requested = false;
    while Instant::now() < deadline {
        if step(&mut recovery, 0).causes & RetirementCause::OwnerLost as u8 != 0 {
            requested = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let outcome = match watcher.stop_and_join(Duration::from_secs(1)) {
        Ok(outcome) => outcome,
        Err(watcher) => {
            // Preserve the failed join owner; do not silently discard/detach.
            std::mem::forget(watcher);
            panic!("lifeline join failed; owner deliberately retained");
        }
    };
    assert!(requested);
    assert_eq!(outcome, WatcherOutcome::ParentLost);
    assert_eq!(signals(&calls[0]), ["TERM"]);
    assert_eq!(step(&mut recovery, 250_000_000).kill_sent, 1);
    recovery.flush_retirement_invalidation().unwrap();
    assert!(recovery.record().unwrap().input_uncertain);
}

#[test]
fn already_revoked_durable_recovery_needs_no_new_transient_notification() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    assert_eq!(recovery.session.retirement_requests().take_causes(), 0);
    let roots = recovery.record().unwrap().roots.clone();
    let status = step(&mut recovery, 0);
    assert!(status.requested && status.term_sent == 1);
    assert_eq!(status.causes, 0);
    assert_eq!(signals(&calls[0]), ["TERM"]);
    assert_eq!(step(&mut recovery, 250_000_000).kill_sent, 1);
    assert!(step(&mut recovery, 2_000_000_000).unknown);
    assert_eq!(recovery.record().unwrap().roots, roots);
}
