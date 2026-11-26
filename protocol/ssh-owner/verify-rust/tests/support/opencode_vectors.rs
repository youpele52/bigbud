use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

// W2 T-prov production provider leases share the provider vector domain.
#[path = "provider_lease_vectors.rs"]
mod provider_lease_vectors;

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    provider_lease_vectors::verify(values);
    let lease = vec![92; 32];
    assert_frame(
        values,
        "proof_opencode_open",
        request(Operation::OpencodeOpen(v1::ProofOpencodeOpen {
            scope: Some(v1::ProofProviderScope {
                thread_id: "thread-opencode".into(),
                session_epoch: 7,
                cwd: "/fixture/work".into(),
                binary: "/fixture/bin/opencode".into(),
                session_file: None,
            }),
            lease: lease.clone(),
            service_scope: None,
        })),
    );
    assert_frame(
        values,
        "proof_opencode_service_open",
        request(Operation::OpencodeOpen(v1::ProofOpencodeOpen {
            scope: None,
            lease: lease.clone(),
            service_scope: Some(v1::ProviderServiceScope {
                thread_id: "thread-opencode".into(),
                session_epoch: 7,
                cwd: "/fixture/work".into(),
                transport: v1::ProviderServiceTransport::Unspecified.into(),
            }),
        })),
    );
    assert_frame(
        values,
        "proof_opencode_service_open_v2",
        request(Operation::OpencodeOpen(v1::ProofOpencodeOpen {
            scope: None,
            lease: lease.clone(),
            service_scope: Some(v1::ProviderServiceScope {
                thread_id: "thread-opencode".into(),
                session_epoch: 7,
                cwd: "/fixture/work".into(),
                transport: v1::ProviderServiceTransport::V2.into(),
            }),
        })),
    );
    assert_frame(
        values,
        "proof_opencode_status",
        request(Operation::OpencodeStatus(v1::ProofOpencodeLease {
            lease: lease.clone(),
        })),
    );
    assert_frame(
        values,
        "proof_opencode_close",
        request(Operation::OpencodeClose(v1::ProofOpencodeLease {
            lease: lease.clone(),
        })),
    );
    for (name, phase, local_port) in [
        (
            "proof_opencode_ready",
            v1::ProofOpencodePhase::Ready,
            Some(49152),
        ),
        (
            "proof_opencode_closed",
            v1::ProofOpencodePhase::Closed,
            None,
        ),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::ProofOpencode(v1::ProofOpencodeState {
                lease: lease.clone(),
                phase: phase.into(),
                local_port,
                exit_code: None,
                password: None,
            })),
        );
    }
    assert_frame(
        values,
        "proof_opencode_ready_v2",
        reply(Outcome::ProofOpencode(v1::ProofOpencodeState {
            lease: lease.clone(),
            phase: v1::ProofOpencodePhase::Ready.into(),
            local_port: Some(49152),
            exit_code: None,
            password: Some(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
            ),
        })),
    );
}
