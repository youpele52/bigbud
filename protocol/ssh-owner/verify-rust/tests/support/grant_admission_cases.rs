use super::*;
use crate::v1::{ApproveTrust, Empty, ListFolders};

const NOW: u64 = 10;
const PATH: &str = "~/café/資料";
const CHANGED_PATH: &str = "~/café/資料/other";

fn list(path: Option<&str>) -> Operation {
    Operation::ListFolders(ListFolders {
        path: path.map(str::to_owned),
    })
}

pub(super) struct Fixture {
    pub(super) owner: Owner,
    pub(super) session: Option<Session>,
    pub(super) grant: Option<Grant>,
    pub(super) request: Request,
    pub(super) now: u64,
}

impl Fixture {
    pub(super) fn new(class: Class, operation: Operation) -> Self {
        let owner = Owner {
            profile: 1,
            epoch: 2,
            target: "fixture-target",
            generation: 3,
            active_lease: 4,
            disconnected: false,
        };
        let peer = Peer {
            profile: owner.profile,
            session: 5,
            class,
            lease: owner.active_lease,
        };
        let session = owner.bind_session(Some(peer), owner.profile).unwrap();
        let (verb, digest) = normalized_operand(&operation);
        let grant = Grant {
            token: 6,
            session,
            target: owner.target,
            generation: owner.generation,
            verb,
            expires_at: NOW + 2,
            digest,
        };
        let request = Request {
            request_id: vec![7],
            owner_epoch: vec![owner.epoch],
            target_generation: vec![owner.generation],
            target_id: owner.target.into(),
            grant: vec![grant.token],
            target_descriptor: None,
        operation: Some(operation),
        };
        Self {
            owner,
            session: Some(session),
            grant: Some(grant),
            request,
            now: NOW,
        }
    }

    pub(super) fn submit(&self, transport: &mut DummyTransport) -> Result<Admission, ErrorCode> {
        transport.submit(
            self.owner,
            self.session,
            self.grant,
            &self.request,
            self.now,
        )
    }
}

#[test]
fn admits_only_the_five_s1_verbs_for_their_adapter_classes() {
    for (class, operation) in [
        (Class::Control, Operation::InspectTrust(Empty {})),
        (
            Class::Control,
            Operation::ApproveTrust(ApproveTrust {
                challenge: vec![0, 0xfe, 0xff],
            }),
        ),
        (Class::Control, Operation::Connect(Empty {})),
        (Class::Control, Operation::Disconnect(Empty {})),
        (Class::Picker, list(Some(PATH))),
    ] {
        let mut transport = DummyTransport::default();
        let wrong_class = match class {
            Class::Control | Class::Dispatcher => Class::Picker,
            Class::Picker => Class::Control,
        };
        // Even a matching grant record cannot give an authenticated class a foreign verb.
        assert_eq!(
            Fixture::new(wrong_class, operation.clone()).submit(&mut transport),
            Err(ErrorCode::OperationDenied)
        );
        assert_eq!(transport.calls, 0);
        assert_eq!(
            Fixture::new(class, operation).submit(&mut transport),
            Ok(Admission::Executed)
        );
        assert_eq!(transport.calls, 1);
    }
}

#[test]
fn only_a_current_dispatcher_can_issue_the_exact_approved_grant() {
    let operation = list(Some(PATH));
    let mut f = Fixture::new(Class::Picker, operation.clone());
    let session = f.session.unwrap();
    let dispatcher = f
        .owner
        .bind_session(
            Some(Peer {
                class: Class::Dispatcher,
                session: 10,
                ..session.peer
            }),
            f.owner.profile,
        )
        .unwrap();
    let grant = f.grant.unwrap();
    let approval = ProductApproval {
        session,
        target: grant.target,
        generation: grant.generation,
        verb: grant.verb,
        digest: grant.digest,
        expires_at: grant.expires_at,
    };
    let requested = GrantIssue {
        session,
        target: f.owner.target,
        generation: f.owner.generation,
        operation: &operation,
    };
    for (name, issuer, candidate, approved, now) in [
        ("picker can't issue", session, requested, approval, NOW),
        (
            "stale issuer",
            Session {
                epoch: 99,
                ..dispatcher
            },
            requested,
            approval,
            NOW,
        ),
        (
            "foreign target",
            dispatcher,
            GrantIssue {
                target: "other",
                ..requested
            },
            approval,
            NOW,
        ),
        (
            "stale generation",
            dispatcher,
            GrantIssue {
                generation: 99,
                ..requested
            },
            approval,
            NOW,
        ),
        (
            "different path",
            dispatcher,
            GrantIssue {
                operation: &list(Some(CHANGED_PATH)),
                ..requested
            },
            approval,
            NOW,
        ),
        (
            "different verb",
            dispatcher,
            GrantIssue {
                operation: &Operation::Connect(Empty {}),
                ..requested
            },
            approval,
            NOW,
        ),
        (
            "approval for another session",
            dispatcher,
            requested,
            ProductApproval {
                session: dispatcher,
                ..approval
            },
            NOW,
        ),
        (
            "expired approval",
            dispatcher,
            requested,
            approval,
            approval.expires_at,
        ),
    ] {
        assert_eq!(
            f.owner
                .issue_grant(issuer, candidate, approved, grant.token, now),
            Err(ErrorCode::OperationDenied),
            "{name}"
        );
    }
    f.grant = Some(
        f.owner
            .issue_grant(dispatcher, requested, approval, grant.token, NOW)
            .unwrap(),
    );
    assert_eq!(f.grant, Some(grant));
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
    assert_eq!(transport.calls, 1);
}

#[test]
fn invalid_authority_is_denied_before_transport_or_disconnect_status() {
    type Case = (&'static str, fn(&mut Fixture));
    let cases: &[Case] = &[
        ("unauthenticated peer", |f| {
            f.session = f.owner.bind_session(None, f.owner.profile);
        }),
        ("wrong claimed profile", |f| {
            f.session = f.owner.bind_session(Some(f.session.unwrap().peer), 99);
        }),
        ("foreign peer matching its own profile", |f| {
            let peer = Peer {
                profile: 99,
                ..f.session.unwrap().peer
            };
            f.session = f.owner.bind_session(Some(peer), peer.profile);
        }),
        ("wrong grant class", |f| {
            f.grant.as_mut().unwrap().session.peer.class = Class::Control
        }),
        ("wrong grant profile", |f| {
            f.grant.as_mut().unwrap().session.peer.profile = 99
        }),
        ("wrong grant session", |f| {
            f.grant.as_mut().unwrap().session.peer.session = 99
        }),
        ("wrong request epoch", |f| f.request.owner_epoch = vec![99]),
        ("wrong grant epoch", |f| {
            f.grant.as_mut().unwrap().session.epoch = 99
        }),
        ("stale channel", |f| {
            f.owner.epoch = 99;
            f.request.owner_epoch = vec![99];
        }),
        ("wrong request target", |f| {
            f.request.target_id = "other".into()
        }),
        ("wrong grant target", |f| {
            f.grant.as_mut().unwrap().target = "other"
        }),
        ("wrong request generation", |f| {
            f.request.target_generation = vec![99]
        }),
        ("wrong grant generation", |f| {
            f.grant.as_mut().unwrap().generation = 99
        }),
        ("wrong operand digest", |f| {
            f.request.operation = Some(list(Some(CHANGED_PATH)))
        }),
        ("wrong grant verb", |f| {
            f.grant.as_mut().unwrap().verb = Verb::Connect
        }),
        ("foreign grant lease", |f| {
            f.grant.as_mut().unwrap().session.peer.lease = 99
        }),
        ("inactive channel lease", |f| f.owner.active_lease = 99),
        ("missing credential", |f| f.request.grant.clear()),
        ("unknown credential", |f| f.request.grant = vec![99]),
        ("no grant record", |f| f.grant = None),
        ("grant expires at now", |f| {
            f.now = f.grant.unwrap().expires_at
        }),
        ("grant expired earlier", |f| {
            f.now = f.grant.unwrap().expires_at + 1
        }),
        ("no request ID", |f| f.request.request_id.clear()),
        ("absent or unknown operation", |f| {
            f.request.operation = None
        }),
    ];
    for disconnected in [false, true] {
        for (name, change) in cases {
            let mut f = Fixture::new(Class::Picker, list(Some(PATH)));
            f.owner.disconnected = disconnected;
            change(&mut f);
            let mut transport = DummyTransport::default();
            assert_eq!(
                f.submit(&mut transport),
                Err(ErrorCode::OperationDenied),
                "{name}"
            );
            assert_eq!(transport.calls, 0, "{name}");
            assert!(transport.receipts.is_empty(), "{name}");
        }
    }
}

#[test]
fn valid_grants_for_network_work_on_a_disconnected_target_are_blocked() {
    for (class, operation) in [
        (Class::Picker, list(Some(PATH))),
        (Class::Control, Operation::InspectTrust(Empty {})),
        (
            Class::Control,
            Operation::ApproveTrust(ApproveTrust { challenge: vec![1] }),
        ),
    ] {
        let mut f = Fixture::new(class, operation);
        f.owner.disconnected = true;
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::TargetDisconnected));
        assert_eq!(transport.calls, 0);
        assert!(transport.receipts.is_empty());
    }
}

#[test]
fn consumes_own_request_id_once_and_denies_changed_operands() {
    let mut f = Fixture::new(Class::Picker, list(None));
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
    assert_eq!(f.submit(&mut transport), Ok(Admission::DuplicateReceipt));
    f.request.operation = Some(list(Some("")));
    assert_eq!(f.submit(&mut transport), Ok(Admission::DuplicateReceipt));

    let own_id = f.request.request_id.clone();
    f.request.request_id = vec![8];
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
    f.request.request_id = own_id;
    f.request.operation = Some(list(Some(CHANGED_PATH)));
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));

    // A fresh, correctly scoped grant for the changed operand must not let the
    // same session reuse the ID. With a new ID it can execute independently.
    let mut grant = f.grant.unwrap();
    grant.token = 9;
    grant.digest = normalized_operand(f.request.operation.as_ref().unwrap()).1;
    f.request.grant = vec![grant.token];
    f.grant = Some(grant);
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
    assert_eq!(transport.calls, 1);
    assert_eq!(transport.receipts.len(), 1);
    f.request.request_id = vec![8];
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
    assert_eq!(transport.calls, 2);
}

#[test]
fn another_session_cannot_replay_a_grant_but_can_use_its_own_request_id() {
    let mut f = Fixture::new(Class::Picker, list(None));
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));

    let mut peer = f.session.unwrap().peer;
    peer.session += 1;
    f.session = f.owner.bind_session(Some(peer), peer.profile);
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
    assert_eq!(transport.calls, 1);

    let grant = f.grant.as_mut().unwrap();
    grant.session = f.session.unwrap();
    grant.token = 9;
    f.request.grant = vec![grant.token];
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
    assert_eq!(f.submit(&mut transport), Ok(Admission::DuplicateReceipt));
    assert_eq!(transport.calls, 2);
}
