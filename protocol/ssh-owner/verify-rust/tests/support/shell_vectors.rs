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
}
