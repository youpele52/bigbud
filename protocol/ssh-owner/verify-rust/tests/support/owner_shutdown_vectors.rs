//! Drain-time owner shutdown and attach artifact identity vectors (Request
//! 194, Reply 108, ErrorCode 82, ProofAttachProbe field 2 and
//! ProofAttachChallenge field 3; v1.owner_shutdown.proto), encoded
//! independently with prost.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{
    ProofAttachChallenge, ProofAttachProbe, frame::Payload, reply::Outcome, request::Operation,
};

fn run(first: u8) -> Vec<u8> {
    (first..first + 32).collect()
}

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, payload) in [
        (
            "owner_shutdown",
            request(Operation::OwnerShutdown(v1::OwnerShutdown {})),
        ),
        (
            "owner_shutdown_report",
            reply(Outcome::OwnerShutdown(v1::OwnerShutdownReport {
                masters_closed: 2,
                leases_closed: 5,
                attach_cleared: true,
            })),
        ),
        (
            "error_owner_artifact_mismatch",
            reply(Outcome::Error(v1::Error {
                code: v1::ErrorCode::OwnerArtifactMismatch.into(),
                jump_failure: None,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
    for (name, payload) in [
        (
            "attach_probe_identity",
            Payload::ProofAttachProbe(ProofAttachProbe {
                client_nonce: run(32),
                expected_artifact_identity: run(128),
            }),
        ),
        (
            "attach_challenge_identity",
            Payload::ProofAttachChallenge(ProofAttachChallenge {
                server_nonce: run(64),
                proof: run(96),
                owner_artifact_identity: run(160),
            }),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
