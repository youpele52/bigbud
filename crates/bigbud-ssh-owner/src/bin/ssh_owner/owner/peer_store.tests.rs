//! U24 owner pin store, one-time challenges, admission and grant separation.
//! No SSH runs here; the live relay is the rootful Linux fixture test.

use super::*;
use crate::owner::terminal::production_tests::support::Fixture;
use crate::owner_grants::Binding;
use std::os::unix::fs::PermissionsExt;

const PAIRING: &str = "5eb1c0de-1111-4222-8333-444455556666";
const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn challenge(owner: &mut Owner, token: Token) {
    owner.peer.challenges.push(Challenge {
        token,
        host: "192.0.2.7".into(),
        port: 2222,
        key: PresentedKey::parse(KEY).unwrap(),
        issued: Instant::now(),
    });
}

fn approve(token: Token) -> Operation {
    Operation::ApprovePeerPin(v1::ApprovePeerPin {
        challenge: token.to_vec(),
        pairing_id: PAIRING.into(),
        user: "bbpeer".into(),
    })
}

fn revoke() -> Operation {
    Operation::RevokePeerPin(v1::RevokePeerPin {
        pairing_id: PAIRING.into(),
    })
}

fn state(owner: &Owner) -> PathBuf {
    owner.owner_state_dir.clone().unwrap()
}

#[test]
fn production_admits_every_peer_verb_without_a_target() {
    let fixture = Fixture::new();
    let owner = fixture.owner(None);
    for operation in [
        Operation::EnsurePeerCoordinatorKey(v1::Empty {}),
        Operation::InspectPeerHostKey(v1::InspectPeerHostKey::default()),
        approve([1; 32]),
        revoke(),
        Operation::PeerRelayOpen(v1::PeerRelayOpen::default()),
        Operation::PeerRelayStatus(v1::PeerRelayLease::default()),
        Operation::PeerRelayClose(v1::PeerRelayLease::default()),
    ] {
        assert!(owner_wide_verb(&operation));
        assert!(!super::super::dispatch::needs_storage(&operation));
        let request = v1::Request {
            request_id: vec![1],
            owner_epoch: owner.epoch.to_vec(),
            operation: Some(operation),
            ..v1::Request::default()
        };
        assert!(owner.validate(&request).is_ok());
    }
}

#[test]
fn a_challenge_is_one_time_and_approval_writes_only_the_challenged_key() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    assert_eq!(
        owner.dispatch_peer_enrollment(approve([2; 32])).err(),
        Some(ErrorCode::PeerPinUnknown)
    );
    challenge(&mut owner, [3; 32]);
    let Ok(Outcome::PeerPin(pin)) = owner.dispatch_peer_enrollment(approve([3; 32])) else {
        panic!("approval");
    };
    assert_eq!(
        (pin.host.as_str(), pin.port, pin.user.as_str()),
        ("192.0.2.7", 2222, "bbpeer")
    );
    assert!(pin.coordinator_key_fingerprint.starts_with("sha256:"));
    let stored = read_pin(&state(&owner), PAIRING).unwrap().unwrap();
    assert_eq!(stored.key.public_key(), KEY);
    // The same challenge cannot approve twice.
    assert_eq!(
        owner.dispatch_peer_enrollment(approve([3; 32])).err(),
        Some(ErrorCode::PeerPinUnknown)
    );
    let mode = fs::metadata(pin_path(&state(&owner), PAIRING).unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    assert!(matches!(
        owner.dispatch_peer_enrollment(revoke()),
        Ok(Outcome::PeerPin(_))
    ));
    assert_eq!(
        owner.dispatch_peer_enrollment(revoke()).err(),
        Some(ErrorCode::PeerPinUnknown)
    );
}

#[test]
fn an_expired_challenge_is_refused() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    challenge(&mut owner, [4; 32]);
    owner.peer.challenges[0].issued = Instant::now().checked_sub(CHALLENGE_TTL).unwrap();
    assert_eq!(
        owner.dispatch_peer_enrollment(approve([4; 32])).err(),
        Some(ErrorCode::PeerPinUnknown)
    );
}

#[test]
fn approval_validates_pairing_id_and_user() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    for (pairing_id, user) in [
        ("not-a-uuid", "bbpeer"),
        (PAIRING, "-oProxyCommand"),
        (PAIRING, "Root"),
    ] {
        challenge(&mut owner, [5; 32]);
        let operation = Operation::ApprovePeerPin(v1::ApprovePeerPin {
            challenge: vec![5; 32],
            pairing_id: pairing_id.into(),
            user: user.into(),
        });
        assert_eq!(
            owner.dispatch_peer_enrollment(operation).err(),
            Some(ErrorCode::InvalidOperands)
        );
        owner.peer.challenges.clear();
    }
}

#[test]
fn relay_open_uses_only_the_owner_pin_and_bound_coordinator() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    let open = |pairing_id: &str| {
        Operation::PeerRelayOpen(v1::PeerRelayOpen {
            lease: vec![6; 32],
            pairing_id: pairing_id.into(),
        })
    };
    assert_eq!(
        owner.dispatch_peer_relay(open("x")).err(),
        Some(ErrorCode::InvalidOperands)
    );
    assert_eq!(
        owner.dispatch_peer_relay(open(PAIRING)).err(),
        Some(ErrorCode::PeerPinUnknown)
    );
    // A pin bound to another coordinator key refuses before any dial.
    let record = PinRecord {
        host: "192.0.2.7".into(),
        port: 2222,
        user: "bbpeer".into(),
        key: PresentedKey::parse(KEY).unwrap(),
        coordinator: format!("sha256:{}", "0".repeat(64)),
    };
    write_private(
        &pin_path(&state(&owner), PAIRING).unwrap(),
        &record.encode(),
    )
    .unwrap();
    assert_eq!(
        owner.dispatch_peer_relay(open(PAIRING)).err(),
        Some(ErrorCode::PeerAuthRefused)
    );
}

#[test]
fn a_tampered_or_exposed_pin_is_corrupt() {
    let fixture = Fixture::new();
    let owner = fixture.owner(None);
    let path = pin_path(&state(&owner), PAIRING).unwrap();
    let record = format!("host=h\nport=22\nuser=u\nkey={KEY}\ncoordinator=sha256:aa\n");
    write_private(&path, &format!("{record}extra=1\n")).unwrap();
    assert_eq!(
        read_pin(&state(&owner), PAIRING).err(),
        Some(ErrorCode::PeerKeyCorrupt)
    );
    write_private(&path, &record).unwrap();
    assert!(read_pin(&state(&owner), PAIRING).unwrap().is_some());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read_pin(&state(&owner), PAIRING).err(),
        Some(ErrorCode::PeerKeyCorrupt)
    );
}

#[test]
fn a_fixture_owner_refuses_production_peer_verbs() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    owner.production = false;
    assert_eq!(
        owner
            .dispatch_peer_enrollment(Operation::EnsurePeerCoordinatorKey(v1::Empty {}))
            .err(),
        Some(ErrorCode::OperationDenied)
    );
}

/// A grant is bound to its exact operation: ordinary trust and peer grants
/// never substitute for one another, in either direction.
#[test]
fn peer_grants_and_ordinary_trust_grants_are_not_substitutable() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    let peer = Operation::InspectPeerHostKey(v1::InspectPeerHostKey {
        host: "192.0.2.7".into(),
        port: 22,
    });
    let trust = Operation::InspectTrust(v1::Empty {});
    let relay = Operation::PeerRelayOpen(v1::PeerRelayOpen {
        lease: vec![7; 32],
        pairing_id: PAIRING.into(),
    });
    for (index, (issued, presented)) in [
        (trust.clone(), peer.clone()),
        (peer.clone(), trust.clone()),
        (trust, relay.clone()),
        (peer, relay),
    ]
    .into_iter()
    .enumerate()
    {
        let mut request = v1::Request {
            request_id: vec![10 + index as u8],
            owner_epoch: owner.epoch.to_vec(),
            operation: Some(issued.clone()),
            ..v1::Request::default()
        };
        let binding = Binding {
            target_id: String::new(),
            generation: Vec::new(),
        };
        let grant = owner
            .grants
            .issue(&request, binding, issued, Instant::now())
            .unwrap();
        request.grant = grant.to_vec();
        request.operation = Some(presented.clone());
        assert!(
            owner
                .grants
                .consume(&request, presented, Instant::now())
                .is_err(),
            "case {index}"
        );
    }
}
