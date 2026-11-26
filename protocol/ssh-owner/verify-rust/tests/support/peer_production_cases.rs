//! U24 production peer grants: owner-held pin approval, revocation and relay
//! are dispatcher-only and never interchangeable with ordinary trust grants.

use super::cases::Fixture;
use super::v1::{
    ApprovePeerPin, ApproveTrust, Empty, InspectPeerHostKey, PeerRelayLease, PeerRelayOpen,
    RevokePeerPin,
};
use super::*;

const PAIRING: &str = "5eb1c0de-1111-4222-8333-444455556666";

fn refused(issued: Operation, attempted: Operation) {
    let mut f = Fixture::new(Class::Dispatcher, issued);
    f.request.operation = Some(attempted);
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
    assert_eq!(transport.calls, 0);
}

#[test]
fn production_peer_grants_never_substitute_for_ordinary_trust() {
    let inspect = Operation::InspectPeerHostKey(InspectPeerHostKey {
        host: "w1.example.test".into(),
        port: 22,
    });
    let approve = Operation::ApprovePeerPin(ApprovePeerPin {
        challenge: vec![1; 32],
        pairing_id: PAIRING.into(),
        user: "bbpeer".into(),
    });
    let revoke = Operation::RevokePeerPin(RevokePeerPin {
        pairing_id: PAIRING.into(),
    });
    let relay = Operation::PeerRelayOpen(PeerRelayOpen {
        lease: vec![2; 32],
        pairing_id: PAIRING.into(),
    });
    let close = Operation::PeerRelayClose(PeerRelayLease { lease: vec![2; 32] });
    let trust = Operation::InspectTrust(Empty {});
    let approve_trust = Operation::ApproveTrust(ApproveTrust {
        challenge: vec![1; 32],
    });
    for (issued, attempted) in [
        (trust.clone(), inspect.clone()),
        (inspect.clone(), trust.clone()),
        (approve_trust.clone(), approve.clone()),
        (approve.clone(), approve_trust),
        (trust, relay.clone()),
        (inspect.clone(), relay.clone()),
        (approve.clone(), revoke.clone()),
        (relay.clone(), close),
        (
            Operation::ProofInspectPeerHostKey(Default::default()),
            inspect.clone(),
        ),
    ] {
        refused(issued, attempted);
    }
    // Ordinary control and picker classes can never hold a production peer verb.
    for class in [Class::Control, Class::Picker] {
        for operation in [inspect.clone(), approve.clone(), relay.clone()] {
            let f = Fixture::new(class, operation);
            let mut transport = DummyTransport::default();
            assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        }
    }
    for operation in [
        Operation::EnsurePeerCoordinatorKey(Empty {}),
        inspect,
        approve,
        revoke,
        relay,
    ] {
        let f = Fixture::new(Class::Dispatcher, operation);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
    }
}
