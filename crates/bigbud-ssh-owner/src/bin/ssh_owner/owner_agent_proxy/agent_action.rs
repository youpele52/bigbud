//! Owner-compiled agent management verbs (`agent_action`).
//!
//! The caller names one enum verb and supplies no command, argument, cwd or
//! environment. Only INSTALL and UPDATE carry bounded artifact bytes, and those
//! bytes travel on the remote child's stdin. Every accepted operation is
//! tracked by id: a recorded outcome is reattached without replay, and an
//! ambiguous outcome is reported and never retried.

use std::collections::HashMap;

mod recipe;
use crate::{
    transport::{RecipeOutput, Transport},
    v1::{self, AgentActionKind, ErrorCode},
};
use sha2::{Digest, Sha256};

/// One wire frame is capped at 64 KiB, so a single-action artifact is small.
/// Larger builds use the chunked staging lane, not this verb.
pub(crate) const MAX_ARTIFACT_BYTES: usize = 48 * 1024;
const MAX_TRACKED: usize = 128;
const MIN_OPERATION_ID: usize = 16;
const MAX_OPERATION_ID: usize = 64;

pub(crate) type ActionKind = AgentActionKind;

/// Exact identity and bytes of one install/update artifact.
pub(crate) struct Artifact<'a> {
    pub(crate) version: &'a str,
    pub(crate) sha256: &'a str,
    pub(crate) size: usize,
    pub(crate) bytes: &'a [u8],
}

enum Record {
    /// The remote result could not be confirmed. Reattach only.
    Unknown(v1::AgentActionResult),
    Settled(v1::AgentActionResult),
}

/// Bounded per-owner operation table. Entries are never evicted within an
/// epoch, so a replay of a known id can never be mistaken for a new operation.
#[derive(Default)]
pub(crate) struct Operations {
    entries: HashMap<Vec<u8>, Record>,
}

impl Operations {
    fn known(&self, id: &[u8], action: AgentActionKind) -> Option<v1::AgentActionResult> {
        match self.entries.get(id)? {
            Record::Unknown(result) | Record::Settled(result) => {
                let mut replay = result.clone();
                replay.reattached = true;
                // A recorded result for a different verb is a different request.
                (replay.action == action as i32).then_some(replay)
            }
        }
    }

    fn record(&mut self, id: &[u8], result: &v1::AgentActionResult) -> Result<(), ErrorCode> {
        if !self.entries.contains_key(id) && self.entries.len() >= MAX_TRACKED {
            return Err(ErrorCode::OwnerUnavailable);
        }
        let record = if result.outcome_unknown {
            Record::Unknown(result.clone())
        } else {
            Record::Settled(result.clone())
        };
        self.entries.insert(id.to_vec(), record);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

impl crate::owner::Owner {
    pub(crate) fn agent_action(
        &mut self,
        operand: &v1::AgentAction,
    ) -> Result<v1::AgentActionResult, ErrorCode> {
        let action =
            AgentActionKind::try_from(operand.action).map_err(|_| ErrorCode::InvalidOperands)?;
        if action == AgentActionKind::Unspecified {
            return Err(ErrorCode::InvalidOperands);
        }
        validate_operation_id(&operand.operation_id)?;
        if let Some(replay) = self.agent_actions.known(&operand.operation_id, action) {
            return Ok(replay);
        }
        // A reattach to an operation this owner never accepted is a refusal, not
        // a fresh operation: the caller may be racing a lost acknowledgement.
        if operand.reattach {
            return Err(ErrorCode::OperationDenied);
        }
        let artifact = artifact_operand(action, operand)?;
        let result = run(
            crate::owner::present(&self.transport)?,
            action,
            operand,
            artifact.as_ref(),
        )?;
        self.agent_actions.record(&operand.operation_id, &result)?;
        Ok(result)
    }
}

fn run(
    transport: &Transport,
    action: AgentActionKind,
    operand: &v1::AgentAction,
    artifact: Option<&Artifact<'_>>,
) -> Result<v1::AgentActionResult, ErrorCode> {
    match recipe::execute(transport, action, artifact) {
        Ok(output) => {
            let outcome_unknown = mutating_outcome_unknown(action, output.code);
            Ok(assemble(action, operand, output, outcome_unknown))
        }
        Err(code) if failure_is_unknown(action, code) => Ok(assemble(
            action,
            operand,
            RecipeOutput {
                code: None,
                stdout: Vec::new(),
                stderr: Vec::new(),
                truncated: false,
            },
            true,
        )),
        Err(code) => Err(code),
    }
}

/// A mutating action that exited 255 (transport refusal) or without a status may
/// already have changed the host.
const fn mutating_outcome_unknown(action: AgentActionKind, code: Option<i32>) -> bool {
    mutates(action) && matches!(code, None | Some(255))
}

/// A timeout or transport loss during a mutation is ambiguous, never retryable.
const fn failure_is_unknown(action: AgentActionKind, code: ErrorCode) -> bool {
    mutates(action)
        && matches!(
            code,
            ErrorCode::ShellTimedOut | ErrorCode::TransportLost | ErrorCode::OutcomeUnknown
        )
}

fn assemble(
    action: AgentActionKind,
    operand: &v1::AgentAction,
    output: RecipeOutput,
    outcome_unknown: bool,
) -> v1::AgentActionResult {
    v1::AgentActionResult {
        action: action as i32,
        operation_id: operand.operation_id.clone(),
        exit_code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        outcome_unknown,
        reattached: false,
    }
}

const fn mutates(action: AgentActionKind) -> bool {
    matches!(
        action,
        AgentActionKind::Install
            | AgentActionKind::Update
            | AgentActionKind::Remove
            | AgentActionKind::Start
            | AgentActionKind::Stop
            | AgentActionKind::Wake
    )
}

fn validate_operation_id(id: &[u8]) -> Result<(), ErrorCode> {
    if !(MIN_OPERATION_ID..=MAX_OPERATION_ID).contains(&id.len()) {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(())
}

fn artifact_operand(
    action: AgentActionKind,
    operand: &v1::AgentAction,
) -> Result<Option<Artifact<'_>>, ErrorCode> {
    let takes_bytes = matches!(action, AgentActionKind::Install | AgentActionKind::Update);
    if !takes_bytes {
        if operand.artifact.is_some()
            || operand.artifact_version.is_some()
            || operand.artifact_sha256.is_some()
            || operand.artifact_size.is_some()
            || operand.artifact_target_triple.is_some()
        {
            return Err(ErrorCode::InvalidOperands);
        }
        return Ok(None);
    }
    let (Some(version), Some(sha256), Some(size), Some(target_triple), Some(bytes)) = (
        operand.artifact_version.as_deref(),
        operand.artifact_sha256.as_deref(),
        operand.artifact_size,
        operand.artifact_target_triple.as_deref(),
        operand.artifact.as_deref(),
    ) else {
        return Err(ErrorCode::InvalidOperands);
    };
    let size = usize::try_from(size).map_err(|_| ErrorCode::InvalidOperands)?;
    if !safe_label(version)
        || !safe_label(target_triple)
        || !valid_sha256(sha256)
        || !(1..=MAX_ARTIFACT_BYTES).contains(&size)
        || bytes.len() != size
    {
        return Err(ErrorCode::InvalidOperands);
    }
    let mut digest = Sha256::new();
    digest.update(bytes);
    if format!("{:x}", digest.finalize()) != sha256 {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(Some(Artifact {
        version,
        sha256,
        size,
        bytes,
    }))
}

fn safe_label(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

#[cfg(test)]
#[path = "agent_action_tests.rs"]
mod tests;
