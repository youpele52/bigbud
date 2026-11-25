use super::cases::Fixture;
use super::v1::{
    Empty, ProofRunAcpCommand, ProofRunProviderWorkspaceShell, ProofRunThreadShell,
    ProofTerminalOpen, ProofWorkspaceRead, proof_workspace_read,
};
use super::*;

fn thread_shell() -> Operation {
    Operation::ProofRunThreadShell(ProofRunThreadShell {
        workspace_root: "/fixture/root".into(),
        cwd: "/fixture/root".into(),
        thread_id: "thread-1".into(),
        command: "printf thread".into(),
        timeout_ms: 30_000,
    })
}

fn provider_shell() -> Operation {
    Operation::ProofRunProviderWorkspaceShell(ProofRunProviderWorkspaceShell {
        workspace_root: "/fixture/root".into(),
        cwd: "/fixture/root".into(),
        provider: "cursor".into(),
        session_id: "session-1".into(),
        invocation_id: "invocation-1".into(),
        command: "printf provider".into(),
        timeout_ms: 30_000,
    })
}

fn acp_command() -> Operation {
    Operation::ProofRunAcpCommand(ProofRunAcpCommand {
        workspace_root: "/fixture/root".into(),
        cwd: "/fixture/root".into(),
    })
}

fn terminal() -> Operation {
    Operation::ProofOpenTerminal(ProofTerminalOpen { lease: Vec::new() })
}

fn workspace_read() -> Operation {
    Operation::ProofWorkspaceRead(ProofWorkspaceRead {
        workspace_root: "/fixture/root".into(),
        relative_path: "a.txt".into(),
        read: Some(proof_workspace_read::Read::Preview(Empty {})),
    })
}

#[test]
fn exec_class_grants_are_not_substitutable_across_roles() {
    // Each exec verb is a distinct authority. Borrowing another role's grant,
    // or issuing an exec grant to a picker/control/read class, is refused
    // before any transport work.
    for (issued, attempted) in [
        (thread_shell(), provider_shell()),
        (thread_shell(), acp_command()),
        (provider_shell(), thread_shell()),
        (provider_shell(), acp_command()),
        (acp_command(), thread_shell()),
        (acp_command(), provider_shell()),
        (workspace_read(), thread_shell()),
        (workspace_read(), provider_shell()),
        (workspace_read(), acp_command()),
        // And the reverse: an exec grant cannot become a read, monitor or PTY grant.
        (thread_shell(), workspace_read()),
        (acp_command(), workspace_read()),
        (provider_shell(), terminal()),
    ] {
        let mut f = Fixture::new(Class::Dispatcher, issued);
        f.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
        assert!(transport.receipts.is_empty());
    }
    for class in [Class::Picker, Class::Control] {
        for operation in [thread_shell(), provider_shell(), acp_command()] {
            let f = Fixture::new(class, operation);
            let mut transport = DummyTransport::default();
            assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
            assert_eq!(transport.calls, 0);
        }
    }
    for operation in [thread_shell(), provider_shell(), acp_command()] {
        let f = Fixture::new(Class::Dispatcher, operation);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
        assert_eq!(transport.calls, 1);
    }
}
