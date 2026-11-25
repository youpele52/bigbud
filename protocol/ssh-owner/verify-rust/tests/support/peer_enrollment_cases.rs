use super::cases::Fixture;
use super::v1::{Empty, ProofInspectPeerHostKey, ProofTerminalOpen};
use super::*;

#[test]
fn peer_enrollment_grants_are_separate_from_trust_monitor_and_pty() {
    let ensure = Operation::ProofEnsurePeerCoordinatorKey(Empty {});
    let inspect = Operation::ProofInspectPeerHostKey(ProofInspectPeerHostKey {
        host: "w1.example.test".into(),
        port: 22,
    });
    let inspect_other_port = Operation::ProofInspectPeerHostKey(ProofInspectPeerHostKey {
        host: "w1.example.test".into(),
        port: 2222,
    });
    let health = Operation::ProofSampleHealth(Empty {});
    let pty = Operation::ProofOpenTerminal(ProofTerminalOpen { lease: Vec::new() });

    // An issued peer-enrollment grant cannot be spent on ordinary trust, a
    // monitor sample or a PTY lease.
    for attempted in [
        Operation::InspectTrust(Empty {}),
        health.clone(),
        pty.clone(),
    ] {
        let mut f = Fixture::new(Class::Dispatcher, ensure.clone());
        f.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
        assert!(transport.receipts.is_empty());
    }
    // And the reverse: ordinary trust, monitor and PTY grants cannot satisfy
    // peer enrollment, even when the same dispatcher holds the record.
    for (issued, attempted) in [
        (Operation::InspectTrust(Empty {}), inspect.clone()),
        (health.clone(), ensure.clone()),
        (pty.clone(), inspect.clone()),
    ] {
        let mut f = Fixture::new(Class::Dispatcher, issued);
        f.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
    }
    // The exact endpoint is part of the digest: the same verb on another port
    // cannot reuse the grant (wrong host/port refusal).
    let mut f = Fixture::new(Class::Dispatcher, inspect.clone());
    f.request.operation = Some(inspect_other_port);
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));

    // Neither a control nor a picker class can hold these verbs.
    for class in [Class::Picker, Class::Control] {
        let f = Fixture::new(class, inspect.clone());
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
    }
    for operation in [ensure, inspect] {
        let f = Fixture::new(Class::Dispatcher, operation);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
        assert_eq!(transport.calls, 1);
    }
}
