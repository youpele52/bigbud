use super::*;
use crate::v1::{ProofStorageResult, ProofStorageTransition};

#[test]
fn transitions_change_fences_only_after_commit_and_revoke_approval() {
    let (mut session, mut wire, mut accepted) = start(true);
    let inspect = |a: &HelloAccepted, id| request(a, id, Operation::InspectTrust(Empty {}));
    let blocked = grant(&mut session, &mut wire, inspect(&accepted, 1));
    assert_error(
        invoke(&mut session, &mut wire, blocked),
        ErrorCode::TargetDisconnected,
    );
    assert_eq!(session.transport.probes.get(), 0);

    transition(&mut session, &mut wire, &mut accepted, 2, false, 6);
    let valid_inspect = grant(&mut session, &mut wire, inspect(&accepted, 3));
    let Outcome::Trust(challenge) = invoke(&mut session, &mut wire, valid_inspect) else {
        panic!("expected a trust challenge");
    };
    assert_eq!(challenge.state, TrustState::ApprovalRequired as i32);
    let approval = |a: &HelloAccepted, id| {
        request(
            a,
            id,
            Operation::ApproveTrust(ApproveTrust {
                challenge: challenge.challenge.clone(),
            }),
        )
    };
    let pending_approve = grant(&mut session, &mut wire, approval(&accepted, 4));
    transition(&mut session, &mut wire, &mut accepted, 5, true, 7);
    assert_error(
        invoke(&mut session, &mut wire, pending_approve),
        ErrorCode::StaleGeneration,
    );
    transition(&mut session, &mut wire, &mut accepted, 6, false, 8);
    let stale_challenge = grant(&mut session, &mut wire, approval(&accepted, 7));
    assert_error(
        invoke(&mut session, &mut wire, stale_challenge),
        ErrorCode::OperationDenied,
    );
    assert_eq!(session.transport.approvals.get(), 0);
}

fn transition(
    session: &mut Session<FakeTransport>,
    wire: &mut Wire,
    accepted: &mut HelloAccepted,
    id: u8,
    disconnected: bool,
    expected_seq: u64,
) {
    let operation = if disconnected {
        Operation::Disconnect(Empty {})
    } else {
        Operation::Connect(Empty {})
    };
    let request = grant(session, wire, request(accepted, id, operation));
    wire.input
        .push_back(Payload::ProofStorageResult(ProofStorageResult {
            request_id: request.request_id.clone(),
            seq: expected_seq + 1,
            committed: true,
            error: 0,
        }));
    session
        .dispatch(wire, Payload::Request(request))
        .expect("dispatch transition");
    assert_eq!(
        wire.output.pop_front(),
        Some(Payload::ProofStorageTransition(ProofStorageTransition {
            request_id: vec![id],
            target_id: TARGET.into(),
            writer_epoch: "writer".into(),
            expected_seq,
            disconnected,
        }))
    );
    let Some(Payload::Reply(reply)) = wire.output.pop_front() else {
        panic!("expected reply after transition receipt");
    };
    assert_eq!(
        reply.outcome,
        Some(Outcome::Connection(Connection {
            state: if disconnected {
                ConnectionState::Disconnected
            } else {
                ConnectionState::Connected
            }
            .into(),
        }))
    );
    assert_ne!(reply.target_generation, accepted.proof_target_generation);
    accepted.proof_target_generation = reply.target_generation;
}

#[test]
fn missing_commit_reply_ends_dispatch_without_acknowledgment_or_retry() {
    let (mut session, mut wire, accepted) = start(false);
    let disconnect = grant(
        &mut session,
        &mut wire,
        request(&accepted, 1, Operation::Disconnect(Empty {})),
    );
    assert!(
        session
            .dispatch(&mut wire, Payload::Request(disconnect))
            .is_err()
    );
    assert!(matches!(
        wire.output.pop_front(),
        Some(Payload::ProofStorageTransition(_))
    ));
    assert!(wire.output.is_empty());
    // A new process/session must hydrate; it cannot accept old grants or query
    // the wire for the previous result. The adapter supplies the durable flag.
    let (mut restarted, mut wire, fresh) = start(true);
    assert_ne!(fresh.owner_epoch, accepted.owner_epoch);
    let list = grant(
        &mut restarted,
        &mut wire,
        request(
            &fresh,
            2,
            Operation::ListFolders(ListFolders { path: None }),
        ),
    );
    assert_error(
        invoke(&mut restarted, &mut wire, list),
        ErrorCode::TargetDisconnected,
    );
    assert_eq!(restarted.transport.listings.get(), 0);
}
