use std::collections::BTreeMap;

#[path = "terminal_inspect_vectors.rs"]
mod terminal_inspect_vectors;

use super::{assert_frame, reply, request, v1};
use v1::{
    ProofTerminal, ProofTerminalLease, ProofTerminalOpen, reply::Outcome, request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    terminal_inspect_vectors::verify(values);
    let lease = || vec![0xaa, 0xbb];
    for (name, payload) in [
        (
            "proof_terminal_open",
            request(Operation::OpenTerminal(ProofTerminalOpen::default())),
        ),
        (
            "proof_terminal_status",
            request(Operation::TerminalStatus(ProofTerminalLease {
                lease: lease(),
            })),
        ),
        (
            "proof_terminal_close",
            request(Operation::CloseTerminal(ProofTerminalLease {
                lease: lease(),
            })),
        ),
        (
            "proof_terminal_reply",
            reply(Outcome::ProofTerminal(ProofTerminal {
                lease: lease(),
                pid: 271,
                live: true,
                sample: b"proof".to_vec(),
                birth_generation: None,
                next_input_sequence: None,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
