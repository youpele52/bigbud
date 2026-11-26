use std::collections::BTreeMap;

#[path = "peer_production_vectors.rs"]
mod peer_production_vectors;

use super::{assert_frame, reply, request, v1};
use v1::{
    Empty, ProofInspectPeerHostKey, ProofPeerCoordinatorKey, ProofPeerHostKey, reply::Outcome,
    request::Operation,
};

const COORDINATOR_KEY: &str =
    "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// Peer enrollment (T-peer / U9): public metadata only, no pin write.
pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    peer_production_vectors::verify(values);
    for (name, payload) in [
        (
            "proof_ensure_peer_coordinator_key",
            request(Operation::ProofEnsurePeerCoordinatorKey(Empty {})),
        ),
        (
            "proof_inspect_peer_host_key",
            request(Operation::ProofInspectPeerHostKey(
                ProofInspectPeerHostKey {
                    host: "w1.example.test".into(),
                    port: 22,
                },
            )),
        ),
        (
            "proof_inspect_peer_host_key_other_port",
            request(Operation::ProofInspectPeerHostKey(
                ProofInspectPeerHostKey {
                    host: "w1.example.test".into(),
                    port: 2222,
                },
            )),
        ),
        (
            "proof_peer_coordinator_key",
            reply(Outcome::ProofPeerCoordinatorKey(ProofPeerCoordinatorKey {
                public_key: format!("ssh-ed25519 {COORDINATOR_KEY}"),
                fingerprint: format!("sha256:{}", "1".repeat(64)),
                algorithm: "ssh-ed25519".into(),
                profile_binding: vec![0x00, 0x61, 0xff],
            })),
        ),
        (
            "proof_peer_host_key",
            reply(Outcome::ProofPeerHostKey(ProofPeerHostKey {
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk".into(),
                public_key: format!("ssh-ed25519 {COORDINATOR_KEY}"),
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
