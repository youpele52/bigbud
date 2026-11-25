use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{
    ProofPackagedRsync, ProofTransferChildState, ProofTransferOperands, ProofTransferScope,
    ProofTransferStream, ProofTransferStreamState, reply::Outcome, request::Operation,
};

fn scope(auth_mode: i32) -> ProofTransferScope {
    ProofTransferScope {
        transfer_id: vec![0x11; 32],
        target_id: "fixture-target".into(),
        target_generation: vec![4],
        auth_mode,
    }
}

fn operands(
    source: &str,
    destination: &str,
    max_bytes: u64,
    max_entries: u32,
) -> ProofTransferOperands {
    ProofTransferOperands {
        source: source.into(),
        destination: destination.into(),
        max_bytes,
        max_entries,
    }
}

/// C15 / W2 T-xfer reserved verb and outcome bytes. Both verifiers encode these
/// fields independently; a change here is a wire change, not a snapshot refresh.
pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let stream_operands = operands("fixture/source", "fixture/destination", 4096, 8);
    let rsync_operands = operands("fixture/tree-a", "fixture/tree-b", 8192, 4);
    for (name, payload) in [
        (
            "proof_transfer_stream",
            request(Operation::ProofTransferStream(ProofTransferStream {
                scope: Some(scope(2)),
                operands: Some(stream_operands),
                launch_attempt: None,
            })),
        ),
        (
            "proof_packaged_rsync",
            request(Operation::ProofPackagedRsync(ProofPackagedRsync {
                scope: Some(scope(1)),
                operands: Some(rsync_operands),
                launch_attempt: None,
            })),
        ),
        (
            "proof_transfer_stream_state_reply",
            reply(Outcome::ProofTransferStreamState(
                ProofTransferStreamState {
                    lease: vec![0x22; 32],
                    sequence: 7,
                    credits: 4096,
                    sent: 48,
                    received: 48,
                    write_closed: true,
                    peer_closed: true,
                    cancelled: false,
                    exited: true,
                    exit_code: Some(0),
                    exit_signal: None,
                },
            )),
        ),
        (
            "proof_transfer_child_state_reply",
            reply(Outcome::ProofTransferChildState(ProofTransferChildState {
                lease: vec![0x33; 32],
                exited: true,
                exit_code: Some(3),
                exit_signal: None,
                cancelled: false,
                charged_trees: 2,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
