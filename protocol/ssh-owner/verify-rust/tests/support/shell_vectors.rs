use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{
    ProofAcpCommandResult, ProofRunAcpCommand, ProofRunProviderWorkspaceShell, ProofRunThreadShell,
    ProofShellResult, reply::Outcome, request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, payload) in [
        (
            "proof_run_thread_shell",
            request(Operation::ProofRunThreadShell(ProofRunThreadShell {
                workspace_root: "/fixture/root".into(),
                cwd: "/fixture/root/sub".into(),
                thread_id: "thread-1".into(),
                command: "printf 'thread\\n'".into(),
                timeout_ms: 30_000,
            })),
        ),
        (
            "proof_run_provider_workspace_shell",
            request(Operation::ProofRunProviderWorkspaceShell(
                ProofRunProviderWorkspaceShell {
                    workspace_root: "/fixture/root".into(),
                    cwd: "/fixture/root".into(),
                    provider: "cursor".into(),
                    session_id: "session-1".into(),
                    invocation_id: "invocation-1".into(),
                    command: "printf 'provider\\n'".into(),
                    timeout_ms: 30_000,
                },
            )),
        ),
        (
            "proof_run_acp_command",
            request(Operation::ProofRunAcpCommand(ProofRunAcpCommand {
                workspace_root: "/fixture/root".into(),
                cwd: "/fixture/root".into(),
            })),
        ),
        (
            "proof_thread_shell_reply",
            reply(Outcome::ProofThreadShell(ProofShellResult {
                output: b"thread\n".to_vec(),
                exit_code: 7,
                truncated: true,
                timed_out: true,
            })),
        ),
        (
            "proof_provider_shell_reply",
            reply(Outcome::ProofProviderWorkspaceShell(ProofShellResult {
                output: b"provider\n".to_vec(),
                exit_code: 9,
                truncated: true,
                timed_out: false,
            })),
        ),
        (
            "proof_acp_command_reply",
            reply(Outcome::ProofAcpCommand(ProofAcpCommandResult {
                output: b"/fixture/root\n".to_vec(),
                exit_code: 5,
                truncated: true,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
    verify_production(values);
}

/// W2 T-shell production exec leases (Request 90–94, Reply 56).
fn verify_production(values: &mut BTreeMap<&str, Vec<u8>>) {
    let (thread, provider, acp) = (vec![90; 32], vec![91; 32], vec![92; 32]);
    for (name, payload) in [
        (
            "run_thread_shell",
            request(Operation::RunThreadShell(v1::RunThreadShell {
                lease: thread.clone(),
                workspace_root: "/srv/work".into(),
                cwd: "/srv/work/sub".into(),
                thread_id: "thread-1".into(),
                command: "printf 'thread\\n'".into(),
                timeout_ms: 30_000,
            })),
        ),
        (
            "run_provider_workspace_shell",
            request(Operation::RunProviderWorkspaceShell(
                v1::RunProviderWorkspaceShell {
                    lease: provider.clone(),
                    workspace_root: "/srv/work".into(),
                    cwd: "/srv/work".into(),
                    provider: "cursor".into(),
                    session_id: "session-1".into(),
                    invocation_id: "invocation-1".into(),
                    command: "printf 'provider\\n'".into(),
                    timeout_ms: 30_000,
                },
            )),
        ),
        (
            "run_acp_command",
            request(Operation::RunAcpCommand(v1::RunAcpCommand {
                lease: acp.clone(),
                workspace_root: "/srv/work".into(),
                cwd: "/srv/work".into(),
            })),
        ),
        (
            "run_acp_shell",
            request(Operation::RunAcpShell(v1::RunAcpShell {
                lease: vec![95; 32],
                workspace_root: "/srv/work".into(),
                cwd: "/srv/work/sub".into(),
                session_id: "acp-session-1".into(),
                tool_call_id: "tool-call-1".into(),
                command: "ls -la".into(),
                timeout_ms: 30_000,
            })),
        ),
        (
            "shell_status",
            request(Operation::ShellStatus(v1::ShellStatus {
                lease: thread.clone(),
                role: v1::ShellRole::Thread.into(),
                offset: 1_048_576,
            })),
        ),
        (
            "shell_close",
            request(Operation::ShellClose(v1::ShellClose {
                lease: acp.clone(),
                role: v1::ShellRole::Acp.into(),
            })),
        ),
        (
            "shell_running",
            reply(Outcome::Shell(v1::ShellState {
                lease: provider,
                role: v1::ShellRole::ProviderWorkspace.into(),
                phase: v1::ShellPhase::Running.into(),
                ..v1::ShellState::default()
            })),
        ),
        (
            "shell_exited",
            reply(Outcome::Shell(v1::ShellState {
                lease: thread,
                role: v1::ShellRole::Thread.into(),
                phase: v1::ShellPhase::Exited.into(),
                output: b"thread\n".to_vec(),
                output_size: 7,
                exit_code: Some(0),
                truncated: true,
            })),
        ),
        (
            "shell_closed",
            reply(Outcome::Shell(v1::ShellState {
                lease: acp,
                role: v1::ShellRole::Acp.into(),
                phase: v1::ShellPhase::Closed.into(),
                ..v1::ShellState::default()
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
