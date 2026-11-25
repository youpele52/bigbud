use std::collections::BTreeMap;

use super::{assert_frame, v1};
use v1::{
    AliasRouteKind, ErrorCode, ListAliases, ListFolders, ProofAliasEntry, ProofAliasUnsupported,
    ProofAliases, ProofGrantReply, ProofStorageHydrate, ProofStorageResult, ProofStorageSnapshot,
    ProofStorageTransition, Reply, Request, frame::Payload, reply::Outcome, request::Operation,
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
