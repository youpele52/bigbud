use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{AgentAction, AgentActionKind, AgentActionResult, reply::Outcome, request::Operation};

fn sequence(first: u8) -> Vec<u8> {
    (first..first + 16).collect()
}

/// Owner-compiled agent actions. Only the install case carries artifact bytes.
pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, payload) in [
        (
            "proof_agent_action",
            request(Operation::AgentAction(AgentAction {
                action: AgentActionKind::Status as i32,
                operation_id: sequence(0),
                artifact_version: None,
                artifact_sha256: None,
                artifact_size: None,
                artifact_target_triple: None,
                artifact: None,
                reattach: false,
            })),
        ),
        (
            "proof_agent_action_reattach",
            request(Operation::AgentAction(AgentAction {
                action: AgentActionKind::Status as i32,
                operation_id: sequence(0),
                artifact_version: None,
                artifact_sha256: None,
                artifact_size: None,
                artifact_target_triple: None,
                artifact: None,
                reattach: true,
            })),
        ),
        (
            "proof_agent_action_install",
            request(Operation::AgentAction(AgentAction {
                action: AgentActionKind::Install as i32,
                operation_id: sequence(16),
                artifact_version: Some("0.3.3".into()),
                artifact_sha256: Some("b".repeat(64)),
                artifact_size: Some(8),
                artifact_target_triple: Some("aarch64-unknown-linux-gnu".into()),
                artifact: Some(vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
                reattach: false,
            })),
        ),
        (
            "proof_agent_action_reply",
            reply(Outcome::ProofAgentAction(AgentActionResult {
                action: AgentActionKind::Status as i32,
                operation_id: sequence(0),
                exit_code: Some(0),
                stdout: b"absent".to_vec(),
                stderr: Vec::new(),
                truncated: false,
                outcome_unknown: false,
                reattached: false,
            })),
        ),
        (
            "proof_agent_action_unknown_reply",
            reply(Outcome::ProofAgentAction(AgentActionResult {
                action: AgentActionKind::Install as i32,
                operation_id: sequence(16),
                exit_code: None,
                stdout: Vec::new(),
                stderr: b"partial".to_vec(),
                truncated: true,
                outcome_unknown: true,
                reattached: true,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
