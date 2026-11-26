use super::cases::Fixture;
use super::v1::{
    Empty, ProofPackagedRsync, ProofPeerRelayOpen, ProofRunThreadShell, ProofTerminalOpen,
    ProofTransferScope, ProofTransferStream,
};
use super::*;

fn transfer_scope() -> ProofTransferScope {
    ProofTransferScope {
        transfer_id: vec![0x11; 32],
        target_id: "fixture-target".into(),
        target_generation: vec![3],
        auth_mode: 2,
    }
}

fn stream() -> Operation {
    Operation::TransferStream(ProofTransferStream {
        scope: Some(transfer_scope()),
        operands: None,
        launch_attempt: None,
    })
}

fn packaged_rsync() -> Operation {
    Operation::PackagedRsync(ProofPackagedRsync {
        scope: Some(ProofTransferScope {
            auth_mode: 1,
            ..transfer_scope()
        }),
        operands: None,
        launch_attempt: None,
    })
}

fn pty() -> Operation {
    Operation::OpenTerminal(ProofTerminalOpen { lease: Vec::new() })
}

fn thread_shell() -> Operation {
    Operation::ProofRunThreadShell(ProofRunThreadShell {
        workspace_root: "/fixture/root".into(),
        cwd: "/fixture/root".into(),
        thread_id: "thread-1".into(),
        command: "true".into(),
        timeout_ms: 1_000,
    })
}

fn peer() -> Operation {
    Operation::ProofPeerRelayOpen(ProofPeerRelayOpen {
        pairing_id: "pairing-1".into(),
        grant_id: "grant-1".into(),
        worker_authority_id: "worker-1".into(),
        host_key_fingerprint: "SHA256:fixture".into(),
        coordinator_key_fingerprint: "sha256:fixture".into(),
    })
}

/// C15 / W2 T-xfer. The reserved transfer verbs have no admitting class in
/// S1-S4, and a transfer grant is never interchangeable with a PTY, shell,
/// peer or ordinary-trust grant.
#[test]
fn transfer_grants_are_admitted_by_no_class_and_substitute_for_no_role() {
    for operation in [stream(), packaged_rsync()] {
        for class in [Class::Dispatcher, Class::Control, Class::Picker] {
            let fixture = Fixture::new(class, operation.clone());
            let mut transport = DummyTransport::default();
            assert_eq!(
                fixture.submit(&mut transport),
                Err(ErrorCode::OperationDenied)
            );
            assert_eq!(transport.calls, 0);
            assert!(transport.receipts.is_empty());
        }
        // Ordinary trust, a PTY, a thread shell and a peer relay can never be
        // spent on a transfer verb, even with a dispatcher class.
        for issued in [
            Operation::InspectTrust(Empty {}),
            pty(),
            thread_shell(),
            peer(),
        ] {
            let mut fixture = Fixture::new(Class::Dispatcher, issued);
            fixture.request.operation = Some(operation.clone());
            let mut transport = DummyTransport::default();
            assert_eq!(
                fixture.submit(&mut transport),
                Err(ErrorCode::OperationDenied)
            );
            assert_eq!(transport.calls, 0);
        }
    }

    // And the reverse: an issued transfer grant cannot be spent on another
    // role, including the other transfer verb.
    for (issued, attempted) in [
        (stream(), Operation::InspectTrust(Empty {})),
        (stream(), pty()),
        (stream(), thread_shell()),
        (stream(), peer()),
        (stream(), packaged_rsync()),
        (packaged_rsync(), stream()),
    ] {
        let mut fixture = Fixture::new(Class::Dispatcher, issued);
        fixture.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(
            fixture.submit(&mut transport),
            Err(ErrorCode::OperationDenied)
        );
        assert_eq!(transport.calls, 0);
    }
}
