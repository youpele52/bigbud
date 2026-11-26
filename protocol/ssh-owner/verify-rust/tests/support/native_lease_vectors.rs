use std::collections::BTreeMap;

use super::{assert_frame, opencode_vectors, reply, request, v1};
use v1::proof_workspace_mode_inspection::Result;
use v1::{
    ProofAgentProxyClose, ProofAgentProxyOpen, ProofAgentProxyStatus, ProofPrepareTerminal,
    ProofTerminalCwd, ProofTerminalInput, ProofTerminalLease, ProofTerminalOpen,
    ProofTerminalReplay, ProofTerminalReplayChunk, ProofTerminalReplayRequest,
    ProofTerminalReservation, ProofTerminalResize, reply::Outcome, request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    assert_frame(
        values,
        "proof_unlock_synthetic_posix_password",
        request(Operation::ProofUnlockSyntheticPosixPassword(v1::Empty {})),
    );
    assert_frame(
        values,
        "proof_synthetic_posix_password_unlocked",
        reply(Outcome::ProofSyntheticPosixPasswordUnlocked(v1::Empty {})),
    );

    opencode_vectors::verify(values);
    super::git_upload_vectors::verify(values);
    super::remote_backend_vectors::verify(values);

    assert_frame(
        values,
        "proof_workspace_mode_publish",
        request(Operation::ProofWorkspaceModePublish(
            v1::ProofWorkspaceModePublish {
                root: "/fixture/root".into(),
                publication_token: vec![81; 32],
                next_record: "canonical claim fixture".into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_workspace_mode_publication",
        reply(Outcome::ProofWorkspaceModePublication(
            v1::ProofWorkspaceModePublication {
                status: v1::ProofWorkspaceModePublishStatus::Committed.into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_workspace_mode_inspect",
        request(Operation::ProofWorkspaceModeInspect(
            v1::ProofWorkspaceModeInspect {
                root: "/fixture/root".into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_workspace_mode_ready",
        reply(Outcome::ProofWorkspaceModeInspection(
            v1::ProofWorkspaceModeInspection {
                result: Some(Result::Ready(v1::ProofWorkspaceModeReady {
                    physical_root: "/fixture/root".into(),
                    host_identity: format!("machine-v1:{}", "a".repeat(64)),
                    account_uid: 1000,
                    realpath_sha256: "b".repeat(64),
                    generation: 0,
                    current_record: None,
                    publication_token: vec![81; 32],
                })),
            },
        )),
    );
    assert_frame(
        values,
        "proof_workspace_mode_refused",
        reply(Outcome::ProofWorkspaceModeInspection(
            v1::ProofWorkspaceModeInspection {
                result: Some(Result::Refusal(
                    v1::ProofWorkspaceModeRefusal::UnsafeStorage.into(),
                )),
            },
        )),
    );
    assert_frame(
        values,
        "proof_git_upload_open",
        request(Operation::ProofGitUploadOpen(v1::ProofGitUploadOpen {
            repository_path: "/tmp/bigbud-picker-linux-Fixture/upload.git".into(),
        })),
    );
    assert_frame(
        values,
        "proof_deployment_manifest_put",
        request(Operation::ProofDeploymentManifestPut(
            v1::ProofDeploymentManifestPut {
                request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
                manifest_sha256: "8f36ab2b3fd94e8d14eae1e5904e6b9be0d43de0dad112009a6ca8b91080f85b"
                    .into(),
                contents: b"manifest fixture".to_vec(),
            },
        )),
    );

    assert_frame(
        values,
        "proof_peer_relay_open",
        request(Operation::ProofPeerRelayOpen(v1::ProofPeerRelayOpen {
            pairing_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
            grant_id: "8c401406-d510-44a8-8111-123456789aaa".into(),
            worker_authority_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            host_key_fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            coordinator_key_fingerprint:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        })),
    );
    assert_frame(
        values,
        "proof_git_advertisement_open",
        request(Operation::ProofGitAdvertisementOpen(
            v1::ProofGitAdvertisementOpen {
                repository_path: "/tmp/bigbud-picker-linux-Fixture/receive.git".into(),
                source_ref: "refs/heads/source".into(),
                destination_ref: "refs/heads/main".into(),
                source_oid: "1111111111111111111111111111111111111111".into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_deployment_stage_begin",
        request(Operation::ProofDeploymentStageBegin(
            v1::ProofDeploymentStageBegin {
                request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
                install_name: "0.1.0-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa".into(),
                archive_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                manifest_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .into(),
            },
        )),
    );

    let pi = v1::ProofProviderScope {
        thread_id: "thread-pi".into(),
        session_epoch: 9,
        cwd: "/fixture/work".into(),
        binary: "/fixture/bin/pi".into(),
        session_file: None,
    };
    assert_frame(
        values,
        "proof_pi_probe",
        request(Operation::ProofPiProbe(pi.clone())),
    );
    assert_frame(
        values,
        "proof_pi_open",
        request(Operation::ProofPiOpen(pi.clone())),
    );
    assert_frame(
        values,
        "proof_pi_open_resume",
        request(Operation::ProofPiOpen(v1::ProofProviderScope {
            thread_id: "thread-pi".into(),
            session_epoch: 9,
            cwd: "/fixture/work".into(),
            binary: "/fixture/bin/pi".into(),
            session_file: Some("/fixture/work/.pi/session.jsonl".into()),
        })),
    );
    assert_frame(
        values,
        "proof_pi_version",
        reply(Outcome::ProofPiVersion(v1::ProofProviderVersion {
            code: Some(0),
            stdout: "pi v0.99.0\n".into(),
            stderr: String::new(),
        })),
    );
    let scope = v1::ProofProviderScope {
        thread_id: "thread-codex".into(),
        session_epoch: 7,
        cwd: "/fixture/work".into(),
        binary: "/fixture/bin/codex".into(),
        session_file: None,
    };
    assert_frame(
        values,
        "proof_codex_probe",
        request(Operation::ProofCodexProbe(scope.clone())),
    );
    assert_frame(
        values,
        "proof_codex_open",
        request(Operation::ProofCodexOpen(scope.clone())),
    );
    assert_frame(
        values,
        "proof_codex_version",
        reply(Outcome::ProofCodexVersion(v1::ProofProviderVersion {
            code: Some(0),
            stdout: "codex-cli 0.166.0\n".into(),
            stderr: String::new(),
        })),
    );
    assert_frame(
        values,
        "proof_client_relay_open",
        request(Operation::ProofClientRelayOpen(v1::ProofClientRelayOpen {
            node_binary: "/fixture/bin/node".into(),
            node_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            helper_entry: "/fixture/relay.mjs".into(),
            helper_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .into(),
            authority_id: "cccccccccccccccccccccccccccccccc".into(),
        })),
    );
    let lease = || vec![0xaa, 0xbb];
    let cwd = ProofTerminalCwd {
        cwd: "/fixture/root/project dir".into(),
    };
    assert_frame(
        values,
        "proof_terminal_cwd_request",
        request(Operation::ProofTerminalCwd(cwd.clone())),
    );
    assert_frame(
        values,
        "proof_terminal_cwd_reply",
        reply(Outcome::ProofTerminalCwd(cwd)),
    );
    assert_frame(
        values,
        "proof_terminal_replay_request",
        request(Operation::ProofTerminalReplay(ProofTerminalReplayRequest {
            lease: lease(),
            after_sequence: 2,
        })),
    );
    for (name, first, next, chunks, gap) in [
        (
            "proof_terminal_replay_reply",
            2,
            4,
            vec![ProofTerminalReplayChunk {
                sequence: 3,
                data: b"abcd".to_vec(),
            }],
            false,
        ),
        ("proof_terminal_replay_gap", 5, 7, Vec::new(), true),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::ProofTerminalReplay(ProofTerminalReplay {
                lease: lease(),
                first_retained_sequence: first,
                next_sequence: next,
                chunks,
                gap,
            })),
        );
    }
    for (name, op) in [
        (
            "proof_terminal_prepare",
            Operation::ProofPrepareTerminal(ProofPrepareTerminal {
                cwd: "/fixture/work".into(),
                thread_id: "thread".into(),
                terminal_id: "pane".into(),
                cols: 96,
                rows: 34,
                shell: None,
            }),
        ),
        (
            "proof_terminal_open_reserved",
            Operation::ProofOpenTerminal(ProofTerminalOpen { lease: lease() }),
        ),
        (
            "proof_terminal_cancel_reservation",
            Operation::ProofCancelTerminalReservation(ProofTerminalLease { lease: lease() }),
        ),
        (
            "proof_terminal_input",
            Operation::ProofTerminalInput(ProofTerminalInput {
                lease: lease(),
                sequence: 1,
                data: b"abc\n".to_vec(),
            }),
        ),
        (
            "proof_terminal_resize",
            Operation::ProofTerminalResize(ProofTerminalResize {
                lease: lease(),
                cols: 96,
                rows: 34,
            }),
        ),
        (
            "proof_agent_proxy_open",
            Operation::ProofAgentProxyOpen(ProofAgentProxyOpen {
                binary_path: "/fixture/agent".into(),
                sha256: "a".repeat(64),
            }),
        ),
        (
            "proof_agent_proxy_status",
            Operation::ProofAgentProxyStatus(ProofTerminalLease { lease: lease() }),
        ),
        (
            "proof_agent_proxy_close",
            Operation::ProofAgentProxyClose(ProofAgentProxyClose {
                lease: lease(),
                terminate: true,
                timeout_ms: 2000,
            }),
        ),
    ] {
        assert_frame(values, name, request(op));
    }
    for (name, outcome) in [
        (
            "proof_terminal_reserved",
            Outcome::ProofTerminalReservation(ProofTerminalReservation {
                lease: lease(),
                cancelled: false,
            }),
        ),
        (
            "proof_agent_proxy_exit",
            Outcome::ProofAgentProxy(ProofAgentProxyStatus {
                lease: lease(),
                pid: 271,
                closed: true,
                code: Some(0),
                signal: None,
            }),
        ),
    ] {
        assert_frame(values, name, reply(outcome));
    }
}
