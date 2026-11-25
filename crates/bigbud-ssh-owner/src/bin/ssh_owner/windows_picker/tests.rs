#![allow(clippy::expect_used, clippy::panic)]

use std::{cell::Cell, collections::VecDeque};

mod storage;

use super::*;
use crate::{
    owner_trust::Observation,
    v1::{ApproveTrust, Empty, Hello, ListFolders, ProofStorageSnapshot, TrustState},
};

const TARGET: &str = "picker-target";
const PROFILE: &[u8] = b"windows-fixture-profile";

#[test]
fn windows_password_denial_precedes_dispatch_and_is_never_auth() {
    assert_eq!(
        password_denial(&Operation::ProofUnlockSyntheticPosixPassword(Empty {})),
        Some(ErrorCode::WindowsPasswordUnsupported)
    );
    for operation in [
        Operation::InspectTrust(Empty {}),
        Operation::Connect(Empty {}),
        Operation::ListFolders(ListFolders { path: None }),
    ] {
        assert_eq!(password_denial(&operation), None);
    }
}

#[derive(Default)]
struct Wire {
    input: VecDeque<Payload>,
    output: VecDeque<Payload>,
}

impl PayloadPipe for Wire {
    fn recv(&mut self) -> RunResult<Option<Payload>> {
        Ok(self.input.pop_front())
    }

    fn send(&mut self, payload: Payload) -> RunResult<()> {
        self.output.push_back(payload);
        Ok(())
    }
}

#[derive(Default)]
struct FakeTransport {
    probes: Cell<u32>,
    listings: Cell<u32>,
    approvals: Cell<u32>,
    changed: Cell<bool>,
}

impl TrustTransport for FakeTransport {
    type Key = u8;

    fn observe_key(&self) -> Result<Observation<Self::Key>, ErrorCode> {
        self.probes.set(self.probes.get() + 1);
        Ok(Observation {
            key: 42,
            verified: false,
            key_type: "test-key".into(),
            fingerprint: "test-fingerprint".into(),
            jump_leg: 0,
        })
    }

    fn approve_key(&self, key: &Self::Key) -> Result<(), ErrorCode> {
        self.approvals.set(self.approvals.get() + 1);
        if *key != 42 || self.changed.get() {
            return Err(ErrorCode::HostKeyChanged);
        }
        Ok(())
    }
}

impl PickerTransport for FakeTransport {
    fn list(&self, path: Option<&str>) -> Result<Folders, ErrorCode> {
        if path.is_some() {
            return Err(ErrorCode::InvalidOperands);
        }
        self.listings.set(self.listings.get() + 1);
        Ok(Folders::default())
    }
}

fn hello() -> Hello {
    Hello {
        major: 1,
        minor: 0,
        profile_binding: PROFILE.to_vec(),
        proof_attachment_capability: Vec::new(),
    }
}

fn start(disconnected: bool) -> (Session<FakeTransport>, Wire, HelloAccepted) {
    let mut wire = Wire {
        input: VecDeque::from([
            Payload::Hello(hello()),
            Payload::ProofStorageSnapshot(ProofStorageSnapshot {
                writer_epoch: "writer".into(),
                target_id: TARGET.into(),
                seq: 6,
                disconnected,
                error: 0,
            }),
        ]),
        ..Wire::default()
    };
    let session = Session::bootstrap(&mut wire, PROFILE, TARGET.into(), || {
        Ok(FakeTransport::default())
    })
    .expect("bootstrap picker session");
    let Some(Payload::ProofStorageHydrate(hydrate)) = wire.output.pop_front() else {
        panic!("storage must hydrate before acceptance");
    };
    assert_eq!(hydrate.target_id, TARGET);
    let Some(Payload::HelloAccepted(accepted)) = wire.output.pop_front() else {
        panic!("expected acceptance after hydration");
    };
    (session, wire, accepted)
}

fn request(accepted: &HelloAccepted, id: u8, operation: Operation) -> Request {
    Request {
        request_id: vec![id],
        owner_epoch: accepted.owner_epoch.clone(),
        target_generation: accepted.proof_target_generation.clone(),
        target_id: TARGET.into(),
        grant: Vec::new(),
        operation: Some(operation),
    }
}

fn issue(session: &mut Session<FakeTransport>, wire: &mut Wire, req: &Request) -> ProofGrantReply {
    session
        .dispatch(wire, Payload::ProofGrantRequest(req.clone()))
        .expect("dispatch grant request");
    let Some(Payload::ProofGrantReply(reply)) = wire.output.pop_front() else {
        panic!("expected grant reply");
    };
    assert_eq!(reply.request_id, req.request_id);
    reply
}

fn grant(session: &mut Session<FakeTransport>, wire: &mut Wire, mut req: Request) -> Request {
    let reply = issue(session, wire, &req);
    assert_eq!(reply.error, 0);
    assert_eq!(reply.grant.len(), 32);
    req.grant = reply.grant;
    req
}

fn invoke(session: &mut Session<FakeTransport>, wire: &mut Wire, req: Request) -> Outcome {
    session
        .dispatch(wire, Payload::Request(req))
        .expect("dispatch picker request");
    let Some(Payload::Reply(reply)) = wire.output.pop_front() else {
        panic!("expected operation reply");
    };
    reply.outcome.expect("operation outcome")
}

fn assert_error(outcome: Outcome, code: ErrorCode) {
    assert_eq!(
        outcome,
        Outcome::Error(Error {
            code: code.into(),
            jump_failure: None
        })
    );
}

#[test]
fn rejects_unsupported_hello_before_transport_or_storage() {
    for malformed in [
        Hello {
            major: 2,
            ..hello()
        },
        Hello {
            minor: 1,
            ..hello()
        },
        Hello {
            profile_binding: vec![1],
            ..hello()
        },
        Hello {
            proof_attachment_capability: vec![1; 32],
            ..hello()
        },
    ] {
        let mut wire = Wire {
            input: VecDeque::from([Payload::Hello(malformed)]),
            ..Wire::default()
        };
        let result = Session::<FakeTransport>::bootstrap(&mut wire, PROFILE, TARGET.into(), || {
            panic!("constructing a transport before Hello validation")
        });
        assert!(result.is_err());
        assert!(wire.output.is_empty());
    }
}

#[test]
fn grants_and_execution_refuse_unsupported_operations_and_wrong_bindings() {
    let (mut session, mut wire, accepted) = start(false);
    let mut req = request(&accepted, 1, Operation::InspectTrust(Empty {}));
    req.target_id.push('X');
    let wrong_target = req.clone();
    req.target_id = TARGET.into();
    req.owner_epoch.clear();
    let wrong_epoch = req;
    for denied in [
        wrong_target,
        wrong_epoch,
        request(
            &accepted,
            2,
            Operation::ProofOpenTerminal(Default::default()),
        ),
        request(
            &accepted,
            3,
            Operation::ProofAgentProxyOpen(Default::default()),
        ),
        request(
            &accepted,
            4,
            Operation::ProofWorkspaceRead(Default::default()),
        ),
        request(&accepted, 5, Operation::ProofSampleHealth(Empty {})),
    ] {
        let refusal = issue(&mut session, &mut wire, &denied);
        assert_eq!(refusal.error, ErrorCode::OperationDenied as i32);
        assert!(refusal.grant.is_empty());
        assert_error(
            invoke(&mut session, &mut wire, denied),
            ErrorCode::OperationDenied,
        );
    }
    let mut good = grant(
        &mut session,
        &mut wire,
        request(
            &accepted,
            6,
            Operation::ListFolders(ListFolders { path: None }),
        ),
    );
    let mut changed = good.clone();
    changed.operation = Some(Operation::ListFolders(ListFolders {
        path: Some("/elsewhere".into()),
    }));
    assert_error(
        invoke(&mut session, &mut wire, changed),
        ErrorCode::OperationDenied,
    );
    good.operation = Some(Operation::ListFolders(ListFolders {
        path: Some(String::new()),
    }));
    assert!(matches!(
        invoke(&mut session, &mut wire, good.clone()),
        Outcome::Folders(_)
    ));
    assert_error(
        invoke(&mut session, &mut wire, good),
        ErrorCode::OperationDenied,
    );
    assert_eq!(session.transport.listings.get(), 1);
    assert_eq!(session.transport.probes.get(), 0);
}

#[test]
fn approval_revalidates_the_exact_observation_and_consumes_challenge_on_failure() {
    let (mut session, mut wire, accepted) = start(false);
    let prepare = |session: &mut Session<FakeTransport>, wire: &mut Wire, id| {
        let inspect = grant(
            session,
            wire,
            request(&accepted, id, Operation::InspectTrust(Empty {})),
        );
        let Outcome::Trust(observation) = invoke(session, wire, inspect) else {
            panic!("expected a trust challenge");
        };
        assert_eq!(observation.fingerprint, "test-fingerprint");
        Operation::ApproveTrust(ApproveTrust {
            challenge: observation.challenge,
        })
    };
    let approval = prepare(&mut session, &mut wire, 1);
    let invalid = grant(
        &mut session,
        &mut wire,
        request(
            &accepted,
            2,
            Operation::ApproveTrust(ApproveTrust {
                challenge: vec![99],
            }),
        ),
    );
    assert_error(
        invoke(&mut session, &mut wire, invalid),
        ErrorCode::OperationDenied,
    );
    assert_eq!(session.transport.approvals.get(), 0);

    session.transport.changed.set(true);
    let valid = grant(
        &mut session,
        &mut wire,
        request(&accepted, 3, approval.clone()),
    );
    assert_error(
        invoke(&mut session, &mut wire, valid),
        ErrorCode::HostKeyChanged,
    );
    session.transport.changed.set(false);
    let stale = grant(&mut session, &mut wire, request(&accepted, 4, approval));
    assert_error(
        invoke(&mut session, &mut wire, stale),
        ErrorCode::OperationDenied,
    );
    assert_eq!(session.transport.approvals.get(), 1);

    let approval = prepare(&mut session, &mut wire, 5);
    let valid = grant(&mut session, &mut wire, request(&accepted, 6, approval));
    let Outcome::Trust(verified) = invoke(&mut session, &mut wire, valid) else {
        panic!("expected verified key approval");
    };
    assert_eq!(verified.state, TrustState::Verified as i32);
    assert!(verified.challenge.is_empty());
}
