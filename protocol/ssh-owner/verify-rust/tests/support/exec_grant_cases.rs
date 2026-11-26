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
    Operation::OpenTerminal(ProofTerminalOpen { lease: Vec::new() })
}

fn workspace_read() -> Operation {
    Operation::WorkspaceRead(ProofWorkspaceRead {
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

fn production_thread_shell() -> Operation {
    Operation::RunThreadShell(super::v1::RunThreadShell {
        lease: vec![90; 32],
        workspace_root: "/srv/work".into(),
        cwd: "/srv/work".into(),
        thread_id: "thread-1".into(),
        command: "printf thread".into(),
        timeout_ms: 30_000,
    })
}

fn production_provider_shell() -> Operation {
    Operation::RunProviderWorkspaceShell(super::v1::RunProviderWorkspaceShell {
        lease: vec![91; 32],
        workspace_root: "/srv/work".into(),
        cwd: "/srv/work".into(),
        provider: "cursor".into(),
        session_id: "session-1".into(),
        invocation_id: "invocation-1".into(),
        command: "printf provider".into(),
        timeout_ms: 30_000,
    })
}

fn production_acp_command() -> Operation {
    Operation::RunAcpCommand(super::v1::RunAcpCommand {
        lease: vec![92; 32],
        workspace_root: "/srv/work".into(),
        cwd: "/srv/work".into(),
    })
}

fn shell_status(role: super::v1::ShellRole) -> Operation {
    Operation::ShellStatus(super::v1::ShellStatus {
        lease: vec![90; 32],
        role: role.into(),
        offset: 0,
    })
}

#[test]
fn production_exec_grants_are_not_substitutable_across_roles_or_with_proof_grants() {
    // W2 T-shell: thread, provider and ACP production leases are three grants;
    // a lease status for one role is not a status for another; and none of
    // them can borrow (or lend) a proof exec, read or PTY grant.
    use super::v1::ShellRole;
    for (issued, attempted) in [
        (production_thread_shell(), production_provider_shell()),
        (production_thread_shell(), production_acp_command()),
        (production_provider_shell(), production_thread_shell()),
        (production_provider_shell(), production_acp_command()),
        (production_acp_command(), production_thread_shell()),
        (production_acp_command(), production_provider_shell()),
        (production_thread_shell(), thread_shell()),
        (thread_shell(), production_thread_shell()),
        (provider_shell(), production_provider_shell()),
        (acp_command(), production_acp_command()),
        (production_thread_shell(), shell_status(ShellRole::Thread)),
        (
            shell_status(ShellRole::Thread),
            shell_status(ShellRole::Acp),
        ),
        (shell_status(ShellRole::Acp), production_acp_command()),
        (workspace_read(), production_thread_shell()),
        (terminal(), production_provider_shell()),
        (production_acp_command(), terminal()),
    ] {
        let mut f = Fixture::new(Class::Dispatcher, issued);
        f.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
        assert!(transport.receipts.is_empty());
    }
    for class in [Class::Picker, Class::Control] {
        for operation in [
            production_thread_shell(),
            production_provider_shell(),
            production_acp_command(),
            shell_status(ShellRole::Thread),
        ] {
            let f = Fixture::new(class, operation);
            let mut transport = DummyTransport::default();
            assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
            assert_eq!(transport.calls, 0);
        }
    }
    for operation in [
        production_thread_shell(),
        production_provider_shell(),
        production_acp_command(),
        shell_status(ShellRole::Thread),
    ] {
        let f = Fixture::new(Class::Dispatcher, operation);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
        assert_eq!(transport.calls, 1);
    }
}

fn acp_shell() -> Operation {
    Operation::RunAcpShell(super::v1::RunAcpShell {
        lease: vec![95; 32],
        workspace_root: "/srv/work".into(),
        cwd: "/srv/work".into(),
        session_id: "acp-session-1".into(),
        tool_call_id: "tool-call-1".into(),
        command: "ls -la".into(),
        timeout_ms: 30_000,
    })
}

#[test]
fn acp_shell_grant_is_not_substitutable_with_acp_pwd_g2_or_pty_grants() {
    // U21: the approved ACP terminal command is its own grant; neither the fixed
    // ACP recipe, a G2 shell, a read nor a PTY grant can stand in for it.
    use super::v1::ShellRole;
    for (issued, attempted) in [
        (acp_shell(), production_acp_command()),
        (production_acp_command(), acp_shell()),
        (acp_shell(), production_provider_shell()),
        (production_provider_shell(), acp_shell()),
        (production_thread_shell(), acp_shell()),
        (acp_shell(), shell_status(ShellRole::AcpShell)),
        (workspace_read(), acp_shell()),
        (terminal(), acp_shell()),
    ] {
        let mut f = Fixture::new(Class::Dispatcher, issued);
        f.request.operation = Some(attempted);
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
        assert_eq!(transport.calls, 0);
    }
    for class in [Class::Picker, Class::Control] {
        let f = Fixture::new(class, acp_shell());
        let mut transport = DummyTransport::default();
        assert_eq!(f.submit(&mut transport), Err(ErrorCode::OperationDenied));
    }
    let f = Fixture::new(Class::Dispatcher, acp_shell());
    let mut transport = DummyTransport::default();
    assert_eq!(f.submit(&mut transport), Ok(Admission::Executed));
}
