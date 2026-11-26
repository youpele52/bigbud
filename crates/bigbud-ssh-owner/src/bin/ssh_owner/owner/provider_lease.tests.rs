//! Production provider lease admission and lifecycle at the owner boundary.
//! These run without a live sshd: the lifecycle cases close before the
//! child starts, or let the pinned SSH child fail against a closed port.

use super::{MAX_LEASES, production_verb};
use crate::owner::Owner;
use crate::v1::{
    ErrorCode, ProviderLeaseHandle, ProviderLeaseKind, ProviderLeaseOpen, ProviderLeasePhase,
    ProviderLeaseScope, ProviderLeaseState, ProviderProbe, reply::Outcome, request::Operation,
};
use std::os::unix::{fs::PermissionsExt, net::UnixStream};
use std::{path::Path, thread, time::Duration};

use crate::owner::terminal::production_tests::support;

const TARGET: &str = "ssh:production-a";

fn scope(kind: ProviderLeaseKind) -> ProviderLeaseScope {
    ProviderLeaseScope {
        kind: kind.into(),
        thread_id: "thread-1".into(),
        session_epoch: 1,
        cwd: "/home/tester/work".into(),
        default_mode_user_input: false,
        session_file: None,
        codex_home: None,
    }
}

fn open(lease: u8, kind: ProviderLeaseKind) -> Operation {
    Operation::ProviderLeaseOpen(ProviderLeaseOpen {
        lease: vec![lease; 32],
        scope: Some(scope(kind)),
    })
}

fn state(outcome: Result<Outcome, ErrorCode>) -> ProviderLeaseState {
    match outcome {
        Ok(Outcome::ProviderLease(state)) => state,
        other => panic!("expected a provider lease state, got {other:?}"),
    }
}

fn arm(owner: &mut Owner, kind: ProviderLeaseKind) {
    let worker_kind = if kind == ProviderLeaseKind::Codex {
        super::Kind::Codex
    } else {
        super::Kind::Pi
    };
    let armed = super::Armed::new(worker_kind, owner.generation, &scope(kind));
    owner.lanes.providers.arm(armed, true);
}

/// The support fixture pins only this port; nothing listens on it, so a
/// started SSH client fails (exit 255) without any remote side.
const PINNED_PORT: u16 = 22222;

#[test]
fn production_admits_the_four_provider_verbs_only() {
    assert!(production_verb(&Operation::ProbeProvider(
        ProviderProbe::default()
    )));
    assert!(production_verb(&open(1, ProviderLeaseKind::Pi)));
    assert!(production_verb(&Operation::ProviderLeaseStatus(
        ProviderLeaseHandle::default()
    )));
    assert!(production_verb(&Operation::ProviderLeaseClose(
        ProviderLeaseHandle::default()
    )));
    assert!(!production_verb(&Operation::ProofPiProbe(
        crate::v1::ProofProviderScope::default()
    )));
    let fixture = support::Fixture::new();
    let owner = fixture.owner(None);
    let request = crate::v1::Request {
        request_id: vec![1],
        owner_epoch: owner.epoch.to_vec(),
        target_id: TARGET.into(),
        operation: Some(open(1, ProviderLeaseKind::Codex)),
        ..crate::v1::Request::default()
    };
    assert!(owner.validate(&request).is_ok());
}

#[test]
fn an_open_needs_a_probe_of_the_same_kind_under_the_current_generation() {
    let fixture = support::Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, TARGET, PINNED_PORT);
    let denied = owner.execute_provider_lease(open(1, ProviderLeaseKind::Pi));
    assert_eq!(denied.err(), Some(ErrorCode::OperationDenied));
    arm(&mut owner, ProviderLeaseKind::Codex);
    let other_kind = owner.execute_provider_lease(open(1, ProviderLeaseKind::Pi));
    assert_eq!(other_kind.err(), Some(ErrorCode::OperationDenied));
    for refused in [
        Operation::ProviderLeaseOpen(ProviderLeaseOpen {
            lease: vec![1; 31],
            scope: Some(scope(ProviderLeaseKind::Codex)),
        }),
        Operation::ProviderLeaseOpen(ProviderLeaseOpen {
            lease: vec![1; 32],
            scope: None,
        }),
        Operation::ProbeProvider(ProviderProbe { scope: None }),
    ] {
        let result = owner.execute_provider_lease(refused);
        assert_eq!(result.err(), Some(ErrorCode::InvalidOperands));
    }
    let unknown =
        owner.execute_provider_lease(Operation::ProviderLeaseStatus(ProviderLeaseHandle {
            lease: vec![9; 32],
        }));
    assert_eq!(unknown.err(), Some(ErrorCode::OperationDenied));
    // Retiring the target disarms every probe.
    owner.lanes.providers.revoke().unwrap();
    let disarmed = owner.execute_provider_lease(open(1, ProviderLeaseKind::Codex));
    assert_eq!(disarmed.err(), Some(ErrorCode::OperationDenied));
}

#[test]
fn a_listening_lease_publishes_private_sockets_and_closes_before_any_child() {
    let fixture = support::Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, TARGET, PINNED_PORT);
    arm(&mut owner, ProviderLeaseKind::Pi);
    let listening = state(owner.execute_provider_lease(open(4, ProviderLeaseKind::Pi)));
    assert_eq!(listening.phase, ProviderLeasePhase::Listening as i32);
    let paths = [
        listening.stdio_socket_path.clone().unwrap(),
        listening.stderr_socket_path.clone().unwrap(),
    ];
    assert_ne!(paths[0], paths[1]);
    for path in &paths {
        let socket = std::fs::metadata(path).unwrap();
        assert_eq!(socket.permissions().mode() & 0o777, 0o600);
        let directory = std::fs::metadata(Path::new(path).parent().unwrap()).unwrap();
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    }
    // A duplicate lease token is refused while the first one lives.
    let duplicate = owner.execute_provider_lease(open(4, ProviderLeaseKind::Pi));
    assert_eq!(duplicate.err(), Some(ErrorCode::OperationDenied));
    let closed = state(owner.execute_provider_lease(Operation::ProviderLeaseClose(
        ProviderLeaseHandle { lease: vec![4; 32] },
    )));
    assert_eq!(closed.phase, ProviderLeasePhase::Closed as i32);
    assert!(closed.stdio_socket_path.is_none());
    for path in &paths {
        assert!(!Path::new(path).exists());
        assert!(!Path::new(path).parent().unwrap().exists());
    }
}

#[test]
fn a_child_that_cannot_start_settles_with_a_typed_refusal_after_both_sockets_connect() {
    // The support fixture's SSH client path does not exist, so the spawn after
    // both connections fails; the lease reports it rather than hanging.
    let fixture = support::Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, TARGET, PINNED_PORT);
    arm(&mut owner, ProviderLeaseKind::Codex);
    let listening = state(owner.execute_provider_lease(open(5, ProviderLeaseKind::Codex)));
    let paths = [
        listening.stdio_socket_path.unwrap(),
        listening.stderr_socket_path.unwrap(),
    ];
    let stdio = UnixStream::connect(&paths[0]).unwrap();
    let stderr = UnixStream::connect(&paths[1]).unwrap();
    let status = Operation::ProviderLeaseStatus(ProviderLeaseHandle { lease: vec![5; 32] });
    let mut settled = None;
    for _ in 0..400 {
        match owner.execute_provider_lease(status.clone()) {
            Ok(Outcome::ProviderLease(current))
                if current.phase == ProviderLeasePhase::Listening as i32
                    || current.phase == ProviderLeasePhase::Running as i32 =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            other => {
                settled = Some(other);
                break;
            }
        }
    }
    assert_eq!(
        settled.expect("the lease settles").err(),
        Some(ErrorCode::OwnerUnavailable)
    );
    for path in &paths {
        assert!(!Path::new(path).exists());
    }
    drop((stdio, stderr));
}

#[test]
fn a_target_holds_a_bounded_number_of_live_leases() {
    let fixture = support::Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, TARGET, PINNED_PORT);
    arm(&mut owner, ProviderLeaseKind::Pi);
    let count = u8::try_from(MAX_LEASES).unwrap();
    for lease in 0..count {
        let opened = state(owner.execute_provider_lease(open(lease + 10, ProviderLeaseKind::Pi)));
        assert_eq!(opened.phase, ProviderLeasePhase::Listening as i32);
    }
    let quota = owner.execute_provider_lease(open(99, ProviderLeaseKind::Pi));
    assert_eq!(quota.err(), Some(ErrorCode::SessionQuota));
    // A confirmed close frees a slot for the next session.
    let closed = owner.execute_provider_lease(Operation::ProviderLeaseClose(ProviderLeaseHandle {
        lease: vec![10; 32],
    }));
    assert_eq!(state(closed).phase, ProviderLeasePhase::Closed as i32);
    let reused = state(owner.execute_provider_lease(open(99, ProviderLeaseKind::Pi)));
    assert_eq!(reused.phase, ProviderLeasePhase::Listening as i32);
    owner.lanes.providers.revoke().unwrap();
}

#[test]
fn an_open_must_match_the_exact_scope_the_probe_checked() {
    let fixture = support::Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, TARGET, PINNED_PORT);
    arm(&mut owner, ProviderLeaseKind::Pi);
    // The probe checked no resume file; a resume open is a different scope.
    let mut resume = scope(ProviderLeaseKind::Pi);
    resume.session_file = Some("/home/tester/.pi/agent/sessions/s.jsonl".into());
    let denied = owner.execute_provider_lease(Operation::ProviderLeaseOpen(ProviderLeaseOpen {
        lease: vec![7; 32],
        scope: Some(resume.clone()),
    }));
    assert_eq!(denied.err(), Some(ErrorCode::OperationDenied));
    let mut other_cwd = scope(ProviderLeaseKind::Pi);
    other_cwd.cwd = "/home/tester/other".into();
    let denied = owner.execute_provider_lease(Operation::ProviderLeaseOpen(ProviderLeaseOpen {
        lease: vec![8; 32],
        scope: Some(other_cwd),
    }));
    assert_eq!(denied.err(), Some(ErrorCode::OperationDenied));
    let armed = super::Armed::new(super::Kind::Pi, owner.generation, &resume);
    owner.lanes.providers.arm(armed, true);
    let opened = state(owner.execute_provider_lease(Operation::ProviderLeaseOpen(
        ProviderLeaseOpen {
            lease: vec![7; 32],
            scope: Some(resume),
        },
    )));
    assert_eq!(opened.phase, ProviderLeasePhase::Listening as i32);
    owner.lanes.providers.revoke().unwrap();
}
