//! Production PTY admission at the owner boundary (W3.7 providers).
//!
//! These run without SSH. They prove reservation-before-dispatch, the request's
//! own remote cwd, the generation/target fences and that production never takes
//! the fixture's fixed proof-terminal path. Live open/input/replay stays in the
//! host-gated production fixture test.

use super::*;
use crate::v1::ErrorCode;
use std::{fs, os::unix::fs::DirBuilderExt};

#[path = "production_terminal_tests.support.rs"]
mod support;

use support::{Fixture, request};

const IDENTITY: &str = "/home/tester/work";

#[test]
fn production_admits_terminal_verbs_and_keeps_fixture_only_verbs_refused() {
    use crate::v1::{ProofTerminalLease, request::Operation};

    let fixture = Fixture::new();
    let owner = fixture.owner(None);
    let epoch = owner.epoch.to_vec();
    let envelope = |operation: Operation| crate::v1::Request {
        request_id: vec![1],
        owner_epoch: epoch.clone(),
        target_id: "ssh:production-a".into(),
        operation: Some(operation),
        ..crate::v1::Request::default()
    };

    assert!(
        owner
            .validate(&envelope(Operation::ProofPrepareTerminal(request(
                IDENTITY
            ))))
            .is_ok()
    );
    assert!(
        owner
            .validate(&envelope(Operation::ProofOpenTerminal(
                crate::v1::ProofTerminalOpen::default()
            )))
            .is_ok()
    );
    // Agent proxy leases now have a real per-target provider; admission is open
    // and a missing master/owner-selected agent refuses in dispatch.
    assert!(
        owner
            .validate(&envelope(Operation::ProofAgentProxyOpen(
                crate::v1::ProofAgentProxyOpen::default()
            )))
            .is_ok()
    );
    assert!(
        owner
            .validate(&envelope(Operation::ProofAgentProxyStatus(
                ProofTerminalLease::default()
            )))
            .is_ok()
    );
    assert!(
        owner
            .validate(&envelope(Operation::ProofAgentProxyClose(
                crate::v1::ProofAgentProxyClose::default()
            )))
            .is_ok()
    );
    // OpenCode is Linux-only in v1; every other POSIX host keeps the refusal.
    #[cfg(not(target_os = "linux"))]
    for refused in [
        Operation::ProofOpencodeOpen(crate::v1::ProofOpencodeOpen::default()),
        Operation::ProofOpencodeClose(crate::v1::ProofOpencodeLease::default()),
    ] {
        assert_eq!(
            owner.validate(&envelope(refused)).err(),
            Some(ErrorCode::OperationDenied)
        );
    }
    // Verbs without a production provider stay refused at admission.
    for refused in [
        Operation::ProofPeerRelayOpen(crate::v1::ProofPeerRelayOpen::default()),
        Operation::ProofGitAdvertisementOpen(crate::v1::ProofGitAdvertisementOpen::default()),
        Operation::ProofGitUploadOpen(crate::v1::ProofGitUploadOpen::default()),
        Operation::ProofCodexOpen(crate::v1::ProofProviderScope::default()),
    ] {
        assert_eq!(
            owner.validate(&envelope(refused)).err(),
            Some(ErrorCode::OperationDenied)
        );
    }
}

#[test]
fn production_folder_listing_uses_the_target_master_lane() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:production-a", 22222);
    assert!(owner.lanes.master.is_some());
    // The master lane validates the system image before any dial. The fixture's
    // one-shot transport path would report a trust error instead.
    assert_eq!(
        owner.list_picker_folders(&[1], None).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
}

#[test]
fn production_terminal_requires_a_reservation_and_a_bounded_absolute_cwd() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:production-a", 22222);

    let reservation = owner.prepare_terminal(request(IDENTITY)).unwrap();
    assert_eq!(reservation.lease.len(), 32);

    // Production never takes the fixture's empty-lease fixed command.
    assert_eq!(
        owner.open_terminal(&[]).err(),
        Some(ErrorCode::OperationDenied)
    );

    owner
        .cancel_terminal_reservation(&reservation.lease)
        .unwrap();
    assert_eq!(
        owner.prepare_terminal(request("relative/path")).err(),
        Some(ErrorCode::InvalidOperands)
    );
    assert_eq!(
        owner
            .prepare_terminal(request(&format!("/{}", "a".repeat(4096))))
            .err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn production_terminal_opens_the_target_login_shell_not_the_fixture_command() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:production-a", 22222);
    let reservation = owner.prepare_terminal(request(IDENTITY)).unwrap();

    // The test transport names no system image, so the production provider
    // refuses before any spawn. The fixture proof path would instead have tried
    // to launch that path and reported OwnerUnavailable.
    assert_eq!(
        owner.open_terminal(&reservation.lease).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert!(owner.lanes.terminal.is_none());
    assert!(!owner.lanes.terminal_uncertain);
    assert!(owner.lanes.preparation.is_none());
}

#[test]
fn production_terminal_fences_a_stale_generation() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:production-a", 22222);
    let reservation = owner.prepare_terminal(request(IDENTITY)).unwrap();
    let current = owner.generation;
    owner.generation = [0x5a; 32];

    for result in [
        owner.cancel_terminal_reservation(&reservation.lease).err(),
        owner.open_terminal(&reservation.lease).err(),
        owner.terminal_status(&reservation.lease).err(),
        owner.close_terminal(&reservation.lease).err(),
    ] {
        assert_eq!(result, Some(ErrorCode::OperationDenied));
    }

    owner.generation = current;
    owner
        .cancel_terminal_reservation(&reservation.lease)
        .unwrap();
}

#[test]
fn production_workspace_root_still_fences_the_terminal_cwd() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("workspace");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&workspace)
        .unwrap();
    let mut owner = fixture.owner(Some(&workspace));
    fixture.bind(&mut owner, "ssh:production-a", 22222);

    let reservation = owner
        .prepare_terminal(request(workspace.to_str().unwrap()))
        .unwrap();
    assert_eq!(reservation.lease.len(), 32);
    owner
        .cancel_terminal_reservation(&reservation.lease)
        .unwrap();
    assert_eq!(
        owner.prepare_terminal(request("/home/other")).err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn production_terminal_reservations_stay_with_their_own_target() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:production-a", 22222);
    let first = owner.prepare_terminal(request("/home/a")).unwrap();
    owner.leave_target();

    fixture.bind(&mut owner, "ssh:production-b", 22223);
    let second = owner.prepare_terminal(request("/home/b")).unwrap();
    owner.leave_target();

    assert_ne!(first.lease, second.lease);
    assert!(matches!(
        owner.target_lanes("ssh:production-a"),
        Some(lanes) if lanes.preparation.is_some()
    ));
    assert!(matches!(
        owner.target_lanes("ssh:production-b"),
        Some(lanes) if lanes.preparation.is_some()
    ));
}

#[test]
fn fixture_and_production_terminals_share_the_same_admission_contract() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("workspace");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&workspace)
        .unwrap();
    let mut pinned = fixture.fixture_owner(&workspace);
    let mut production = fixture.owner(Some(&workspace));
    fixture.bind(&mut production, "ssh:production-parity", 22222);

    let at_root = workspace.to_str().unwrap();
    let fixture_lease = pinned.prepare_terminal(request(at_root)).unwrap();
    let production_lease = production.prepare_terminal(request(at_root)).unwrap();
    assert_eq!(fixture_lease.lease.len(), production_lease.lease.len());
    assert!(!fixture_lease.lease.is_empty());
    pinned
        .cancel_terminal_reservation(&fixture_lease.lease)
        .unwrap();
    production
        .cancel_terminal_reservation(&production_lease.lease)
        .unwrap();

    // Both modes reject the same out-of-root cwd.
    for owner in [&mut pinned, &mut production] {
        assert_eq!(
            owner.prepare_terminal(request("/home/outside")).err(),
            Some(ErrorCode::InvalidOperands)
        );
    }

    // Both modes fence a stale generation for the reservation they issued.
    let fixture_lease = pinned.prepare_terminal(request(at_root)).unwrap();
    let production_lease = production.prepare_terminal(request(at_root)).unwrap();
    let production_generation = production.generation;
    production.generation = [0x5a; 32];
    assert_eq!(
        production
            .cancel_terminal_reservation(&production_lease.lease)
            .err(),
        Some(ErrorCode::OperationDenied)
    );
    production.generation = production_generation;
    pinned
        .cancel_terminal_reservation(&fixture_lease.lease)
        .unwrap();
    production
        .cancel_terminal_reservation(&production_lease.lease)
        .unwrap();
}
