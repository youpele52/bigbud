use super::protocol::{
    facts::v1::{Section, ThreadFacts, Work},
    policy::v1::{Limits, Policy},
    scheduling::v1::{Outcome, Receipt, Settings, native_frame},
    v1::{Frame, Hello, SnapshotBegin, SnapshotEnd, SnapshotPage, frame},
};
use super::session::Session;
use super::timing::ClockSample;
use prost::Message;
use sha2::{Digest, Sha256};

fn clock(ms: u64) -> ClockSample {
    ClockSample {
        wall_ms: ms as i64,
        monotonic_ms: ms,
    }
}
fn frame(payload: frame::Payload) -> Vec<u8> {
    Frame {
        backend_nonce: "owner".into(),
        generation: 1,
        payload: Some(payload),
    }
    .encode_to_vec()
}
fn row() -> ThreadFacts {
    ThreadFacts {
        thread_id: "working".into(),
        fact_version: 1,
        section: Section::Later as i32,
        work: Work::Active as i32,
        eligible: true,
        in_scope: Some(true),
        manual_attention_watermark: Some(0),
        ..Default::default()
    }
}
fn activate(session: &mut Session, row: ThreadFacts) {
    let hello = Hello {
        major: 1,
        minor: 0,
        capability: "compact-facts-v1".into(),
        limits: Some(Limits {
            frame_bytes: 1_048_576,
            page_rows: 256,
            live_rows: 100_000,
            state_bytes: 64 * 1024 * 1024,
            pending_facts: 2000,
            pending_bytes: 8 * 1024 * 1024,
        }),
    };
    session
        .receive(&frame(frame::Payload::Hello(hello)), clock(0))
        .expect("hello");
    session
        .receive(
            &frame(frame::Payload::Begin(SnapshotBegin {
                snapshot_id: "snapshot".into(),
                sequence: 1,
                source_frontier: 1,
                policy: Some(Policy {
                    version: 1,
                    fingerprint: "policy".into(),
                    older_policy_changed_at_ms: None,
                    scheduling: Some(Settings {
                        idle_enabled: false,
                        idle_timeout_ms: 600_000,
                        idle_destination: Section::Later as i32,
                        older_enabled: false,
                        older_timeout_ms: 86_400_000,
                        present_target: Some(7),
                        target_not_before_ms: None,
                        grace_ms: 300_000,
                    }),
                }),
            })),
            clock(0),
        )
        .expect("begin");
    let mut digest = Sha256::new();
    let encoded = row.encode_to_vec();
    digest.update((encoded.len() as u32).to_be_bytes());
    digest.update(encoded);
    session
        .receive(
            &frame(frame::Payload::Page(SnapshotPage {
                snapshot_id: "snapshot".into(),
                index: 0,
                rows: vec![row],
            })),
            clock(0),
        )
        .expect("page");
    let ready = session
        .receive(
            &frame(frame::Payload::End(SnapshotEnd {
                snapshot_id: "snapshot".into(),
                pages: 1,
                rows: 1,
                digest: digest.finalize().to_vec(),
                policy_version: 1,
            })),
            clock(0),
        )
        .expect("end");
    assert!(matches!(
        ready[0].payload,
        Some(native_frame::Payload::Ready(_))
    ));
}
#[test]
fn scheduler_is_inert_before_snapshot_then_serializes_ack_and_fact_refresh() {
    let mut session = Session::new("owner".into(), 1, clock(0));
    assert!(session.tick(clock(1)).expect("inactive").is_empty());
    activate(&mut session, row());
    let first = session.tick(clock(100)).expect("proposal");
    let Some(native_frame::Payload::Proposal(proposal)) = first[0].payload.clone() else {
        panic!("proposal expected")
    };
    assert_eq!(proposal.destination, Section::Present as i32);
    assert!(
        session
            .tick(clock(200))
            .expect("waiting for ack")
            .is_empty()
    );
    let retry = session.tick(clock(5300)).expect("same-id retry");
    assert!(
        retry
            .iter()
            .any(|frame| frame.payload == Some(native_frame::Payload::Proposal(proposal.clone())))
    );
    let receipt = Receipt {
        operation_id: proposal.operation_id,
        outcome: Outcome::Applied as i32,
        result_revision: 1,
        result_sequence: 2,
        retry_not_before_ms: None,
    };
    session
        .receive(
            &frame(frame::Payload::Receipt(receipt.clone())),
            clock(5400),
        )
        .expect("ack");
    session
        .receive(&frame(frame::Payload::Receipt(receipt)), clock(5401))
        .expect("idempotent ack");
    assert!(
        session
            .tick(clock(5500))
            .expect("no reproposal without new facts")
            .is_empty()
    );
}
#[test]
fn confirmed_not_due_can_retry_at_same_fact_version_with_new_id_and_paced_attempt() {
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, row());
    let first = session.tick(clock(100)).expect("proposal");
    let Some(native_frame::Payload::Proposal(proposal)) = first[0].payload.clone() else {
        panic!("proposal")
    };
    session
        .receive(
            &frame(frame::Payload::Receipt(Receipt {
                operation_id: proposal.operation_id.clone(),
                outcome: Outcome::NotDue as i32,
                retry_not_before_ms: Some(2000),
                result_revision: 0,
                result_sequence: 0,
            })),
            clock(200),
        )
        .expect("early");
    assert!(session.tick(clock(1999)).expect("not due").is_empty());
    let second = session.tick(clock(2000)).expect("retry at deadline");
    let Some(native_frame::Payload::Proposal(retry)) = second[0].payload.as_ref() else {
        panic!("retry")
    };
    assert_ne!(retry.operation_id, proposal.operation_id);
    assert_eq!(retry.occurrence_id, proposal.occurrence_id);
    assert_eq!(retry.attempt, 1);
    assert_eq!(retry.fact_version, proposal.fact_version);
}
#[test]
fn stale_generation_and_owner_timeout_fail_closed() {
    let mut session = Session::new("owner".into(), 1, clock(0));
    assert!(session.tick(clock(5001)).is_err());
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, row());
    assert!(session.tick(clock(15001)).is_err());
    let stale = Frame {
        backend_nonce: "owner".into(),
        generation: 2,
        payload: Some(frame::Payload::Heartbeat(Default::default())),
    };
    assert!(session.receive(&stale.encode_to_vec(), clock(1)).is_err());
}
fn fact(sequence: u64, row: ThreadFacts) -> Vec<u8> {
    frame(frame::Payload::Fact(super::protocol::facts::v1::Fact {
        sequence,
        source_frontier: 1,
        row: Some(row),
        deleted: false,
    }))
}
fn idle_present(id: &str, version: u64) -> ThreadFacts {
    ThreadFacts {
        thread_id: id.into(),
        fact_version: version,
        section: Section::Present as i32,
        work: Work::Idle as i32,
        ..row()
    }
}
fn proposal_of(frames: &[super::protocol::scheduling::v1::NativeFrame]) -> Option<String> {
    frames.iter().find_map(|frame| match &frame.payload {
        Some(native_frame::Payload::Proposal(proposal)) => Some(proposal.thread_id.clone()),
        _ => None,
    })
}
fn settle(session: &mut Session, frames: &[super::protocol::scheduling::v1::NativeFrame], at: u64) {
    let Some(native_frame::Payload::Proposal(proposal)) =
        frames.iter().find_map(|frame| frame.payload.clone())
    else {
        panic!("proposal expected")
    };
    session
        .receive(
            &frame(frame::Payload::Receipt(Receipt {
                operation_id: proposal.operation_id,
                outcome: Outcome::Stale as i32,
                retry_not_before_ms: None,
                result_revision: 0,
                result_sequence: 0,
            })),
            clock(at),
        )
        .expect("stale receipt");
}
#[test]
fn stale_backoff_is_per_thread_and_unrelated_facts_do_not_lift_it() {
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, row());
    let first = session.tick(clock(100)).expect("proposal");
    settle(&mut session, &first, 200);
    session
        .receive(&fact(2, idle_present("other", 1)), clock(300))
        .expect("fact");
    assert_eq!(
        proposal_of(&session.tick(clock(600)).expect("blocked")),
        None
    );
    let second = session.tick(clock(1200)).expect("backoff elapsed");
    assert_eq!(proposal_of(&second).as_deref(), Some("working"));
    settle(&mut session, &second, 1300);
    session
        .receive(&fact(3, idle_present("other", 2)), clock(1400))
        .expect("fact");
    for at in [1700, 2500, 3299] {
        assert_eq!(
            proposal_of(&session.tick(clock(at)).expect("doubled backoff")),
            None
        );
    }
    assert_eq!(
        proposal_of(&session.tick(clock(3300)).expect("retry")).as_deref(),
        Some("working")
    );
}
#[test]
fn fact_bursts_coalesce_into_spaced_decision_passes() {
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, idle_present("working", 1));
    assert_eq!(
        proposal_of(&session.tick(clock(100)).expect("first pass")),
        None
    );
    session
        .receive(
            &fact(
                2,
                ThreadFacts {
                    fact_version: 2,
                    ..row()
                },
            ),
            clock(150),
        )
        .expect("now active in Later");
    for at in [150, 200, 349] {
        assert_eq!(proposal_of(&session.tick(clock(at)).expect("spaced")), None);
    }
    assert_eq!(
        proposal_of(&session.tick(clock(350)).expect("pass")).as_deref(),
        Some("working")
    );
}
#[test]
fn policy_frames_update_in_place_and_reject_regressions() {
    let policy = |version: u64, barrier: Option<u64>, target: u32| Policy {
        version,
        fingerprint: format!("policy-{version}"),
        older_policy_changed_at_ms: None,
        scheduling: Some(Settings {
            idle_enabled: false,
            idle_timeout_ms: 600_000,
            idle_destination: Section::Later as i32,
            older_enabled: false,
            older_timeout_ms: 86_400_000,
            present_target: Some(target),
            target_not_before_ms: barrier,
            grace_ms: 300_000,
        }),
    };
    let send = |session: &mut Session, policy: Policy| {
        session.receive(&frame(frame::Payload::Policy(policy)), clock(10))
    };
    let mut inactive = Session::new("owner".into(), 1, clock(0));
    assert!(send(&mut inactive, policy(2, None, 7)).is_err());
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, idle_present("working", 1));
    let same = |barrier| Policy {
        fingerprint: "policy".into(),
        ..policy(1, barrier, 7)
    };
    assert!(send(&mut session, same(Some(50))).is_ok());
    assert!(send(&mut session, same(Some(60))).is_ok());
    assert!(send(&mut session, policy(2, Some(60), 3)).is_ok());
    assert!(send(&mut session, policy(1, Some(60), 3)).is_err());
    let mut regress = Session::new("owner".into(), 1, clock(0));
    activate(&mut regress, idle_present("working", 1));
    assert!(send(&mut regress, same(Some(50))).is_ok());
    assert!(send(&mut regress, same(Some(40))).is_err());
}
#[test]
fn quiet_stale_reproposal_gets_a_new_attempt_identity() {
    let proposal = |frames: &[super::protocol::scheduling::v1::NativeFrame]| {
        frames
            .iter()
            .find_map(|frame| match &frame.payload {
                Some(native_frame::Payload::Proposal(proposal)) => Some(proposal.clone()),
                _ => None,
            })
            .expect("proposal")
    };
    let mut session = Session::new("owner".into(), 1, clock(0));
    activate(&mut session, row());
    let first = session.tick(clock(100)).expect("proposal");
    settle(&mut session, &first, 200);
    // No fact of any thread arrives: the backoff alone lifts the block.
    let second = session.tick(clock(1200)).expect("backoff elapsed");
    let (first, second) = (proposal(&first), proposal(&second));
    assert_eq!(first.fact_version, second.fact_version);
    assert_eq!(second.attempt, 0);
    assert_ne!(first.occurrence_id, second.occurrence_id);
    assert_ne!(first.operation_id, second.operation_id);
    settle(&mut session, &[native(second.clone())], 1300);
    let third = proposal(&session.tick(clock(3300)).expect("doubled backoff"));
    assert_ne!(third.occurrence_id, second.occurrence_id);
    assert_ne!(third.operation_id, first.operation_id);
}
fn native(
    proposal: super::protocol::scheduling::v1::Proposal,
) -> super::protocol::scheduling::v1::NativeFrame {
    super::protocol::scheduling::v1::NativeFrame {
        payload: Some(native_frame::Payload::Proposal(proposal)),
        ..Default::default()
    }
}
