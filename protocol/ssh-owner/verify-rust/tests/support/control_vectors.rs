use std::collections::BTreeMap;

use super::{assert_frame, v1};
use v1::{
    AliasRouteKind, ErrorCode, HelloAccepted, ListAliases, ListFolders, ProofAliasEntry,
    ProofAliasUnsupported, ProofAliases, ProofGrantReply, ProofPaneBinding, ProofReconcileHydrate,
    ProofReconcileSnapshot, ProofRetirementEntry, ProofStorageHydrate, ProofStorageResult,
    ProofStorageSnapshot, ProofStorageTransition, Reply, Request, frame::Payload, reply::Outcome,
    request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let id = || b"id".to_vec();
    let target = || "ssh:fixture".to_owned();
    for (name, payload) in [
        (
            "proof_grant_request",
            Payload::ProofGrantRequest(Request {
                request_id: id(),
                owner_epoch: b"owner".to_vec(),
                target_generation: b"gen".to_vec(),
                target_id: target(),
                grant: Vec::new(),
                target_descriptor: None,
                operation: Some(Operation::ListFolders(ListFolders::default())),
            }),
        ),
        (
            "proof_grant_reply",
            Payload::ProofGrantReply(ProofGrantReply {
                request_id: id(),
                grant: b"grant".to_vec(),
                error: ErrorCode::Unspecified.into(),
            }),
        ),
        (
            "proof_storage_hydrate",
            Payload::ProofStorageHydrate(ProofStorageHydrate {
                target_id: target(),
            }),
        ),
        (
            "proof_storage_snapshot",
            Payload::ProofStorageSnapshot(ProofStorageSnapshot {
                target_id: target(),
                writer_epoch: "epoch".into(),
                seq: 7,
                disconnected: true,
                error: ErrorCode::Unspecified.into(),
            }),
        ),
        (
            "proof_storage_transition",
            Payload::ProofStorageTransition(ProofStorageTransition {
                request_id: id(),
                target_id: target(),
                writer_epoch: "epoch".into(),
                expected_seq: 7,
                disconnected: true,
            }),
        ),
        (
            "proof_storage_result",
            Payload::ProofStorageResult(ProofStorageResult {
                request_id: id(),
                seq: 8,
                committed: true,
                error: ErrorCode::Unspecified.into(),
            }),
        ),
        (
            "proof_storage_result_refused",
            Payload::ProofStorageResult(ProofStorageResult {
                request_id: id(),
                error: ErrorCode::StorageUnavailable.into(),
                ..ProofStorageResult::default()
            }),
        ),
        (
            "proof_reconcile_hydrate",
            Payload::ProofReconcileHydrate(ProofReconcileHydrate {
                request_id: vec![0x21; 32],
                owner_epoch: b"\xaa\xbb".to_vec(),
                generation: Vec::new(),
            }),
        ),
        (
            "proof_reconcile_snapshot",
            Payload::ProofReconcileSnapshot(ProofReconcileSnapshot {
                request_id: vec![0x21; 32],
                digest: vec![0x5e; 32],
                retirements: vec![ProofRetirementEntry {
                    target_id: target(),
                    kind: "owner".into(),
                    state: "bound".into(),
                    owner_epoch: "e".repeat(64),
                    pid: 4242,
                    start: 99,
                    namespace: Some(7),
                    detail: "prior owner".into(),
                }],
                panes: vec![ProofPaneBinding {
                    owner_key: format!("terminal:{}", "b".repeat(64)),
                    thread_id: "thread-1".into(),
                    terminal_id: "terminal-1".into(),
                    owner_epoch: "aa".into(),
                    target_id: target(),
                    generation: "generation".into(),
                    lease_id: "reservation-1".into(),
                    state: "prepared".into(),
                    remote_shell_pid: Some(4242),
                    terminated: false,
                }],
                error: ErrorCode::Unspecified.into(),
            }),
        ),
        (
            "proof_reconcile_snapshot_unavailable",
            Payload::ProofReconcileSnapshot(ProofReconcileSnapshot {
                request_id: vec![0x21; 32],
                digest: vec![0x5e; 32],
                error: ErrorCode::StorageUnavailable.into(),
                ..ProofReconcileSnapshot::default()
            }),
        ),
        (
            "hello_accepted_reconciled",
            Payload::HelloAccepted(HelloAccepted {
                major: 1,
                owner_epoch: b"\x00\x2a".to_vec(),
                profile_binding: b"\x00\x61\xff".to_vec(),
                multi_target: true,
                reconciled: true,
                reconciliation_id: (0u8..32).map(|i| 0x20 + i).collect(),
                reconciliation_digest: (0u8..32).map(|i| 0x40 + i).collect(),
                retirement_count: 1,
                pane_count: 1,
                ..HelloAccepted::default()
            }),
        ),
        (
            "hello_accepted_reconciliation_refused",
            Payload::HelloAccepted(HelloAccepted {
                major: 1,
                owner_epoch: b"\x00\x2a".to_vec(),
                profile_binding: b"\x00\x61\xff".to_vec(),
                multi_target: true,
                reconciliation_id: (0u8..32).map(|i| 0x20 + i).collect(),
                reconciliation_digest: (0u8..32).map(|i| 0x40 + i).collect(),
                reconciliation_error: ErrorCode::OwnerRetirementUnverified.into(),
                ..HelloAccepted::default()
            }),
        ),
        (
            "list_aliases",
            Payload::Request(Request {
                request_id: b"\x01\x80\xff".to_vec(),
                owner_epoch: b"\x00\x2a".to_vec(),
                target_generation: b"\x04".to_vec(),
                target_id: "fixture-target".into(),
                grant: b"\x80\x00".to_vec(),
                target_descriptor: None,
                operation: Some(Operation::ListAliases(ListAliases {})),
            }),
        ),
        (
            "proof_aliases",
            Payload::Reply(Reply {
                request_id: b"\x01\x80\xff".to_vec(),
                owner_epoch: b"\x00\x2a".to_vec(),
                target_generation: b"\x04".to_vec(),
                outcome: Some(Outcome::ProofAliases(ProofAliases {
                    entries: vec![
                        ProofAliasEntry {
                            alias: "build-box".into(),
                            host_name: "build.internal".into(),
                            port: 2222,
                            user: "ci".into(),
                            host_key_alias: "build-trust".into(),
                            route_kind: AliasRouteKind::Direct as i32,
                            jump_hops: 0,
                            source: "user_config".into(),
                            line: 5,
                            unsupported: None,
                        },
                        ProofAliasEntry {
                            alias: "blocked".into(),
                            host_name: "blocked.internal".into(),
                            port: 22,
                            user: String::new(),
                            host_key_alias: String::new(),
                            route_kind: AliasRouteKind::Jump as i32,
                            jump_hops: 1,
                            source: "user_config".into(),
                            line: 9,
                            unsupported: Some(ProofAliasUnsupported {
                                reason: "localcommand".into(),
                                remedy: "Remove the unsupported directive from this host.".into(),
                                source: "user_config".into(),
                                line: 9,
                            }),
                        },
                    ],
                    truncated: true,
                    max_entries: 256,
                })),
            }),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
