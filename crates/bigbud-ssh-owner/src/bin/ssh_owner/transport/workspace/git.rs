use super::{
    ErrorCode, Transport, process, quote, root_authority, ssh_failure, v1, validate_path,
    workspace_command,
};
// `quote` and `workspace_command` are used by the recipe child module.
use std::time::Instant;
use v1::{ProofWorkspaceGit, ProofWorkspaceGitOutcome as Outcome, ProofWorkspaceGitResult};

#[path = "git.guard.rs"]
mod guard;
#[path = "git.history.rs"]
mod history;
#[path = "git.recipe.rs"]
mod recipe;
#[path = "git.templates.rs"]
mod templates;

use history::History;
use recipe::Recipe;

const MAX_MUTATION_PATHS: usize = 200;
const MAX_MUTATION_PATH_BYTES: usize = 4096;

/// Path operands are repository-relative data, never options or absolute paths.
fn validate_paths(recipe: Recipe, paths: &[String]) -> Result<(), ErrorCode> {
    let (min, max) = recipe.path_arity();
    if paths.len() < min || paths.len() > max.min(MAX_MUTATION_PATHS) {
        return Err(ErrorCode::InvalidOperands);
    }
    for path in paths {
        if path.is_empty()
            || path.len() > MAX_MUTATION_PATH_BYTES
            || path.contains('\0')
            || path.contains('\\')
            || path.starts_with('/')
            || path.starts_with('-')
            || !path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
        {
            return Err(ErrorCode::InvalidOperands);
        }
    }
    Ok(())
}

pub(in super::super) fn execute(
    transport: &Transport,
    operand: &ProofWorkspaceGit,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let recipe = Recipe::from_action(operand.action)?;
    validate_paths(recipe, &operand.paths)?;
    let history = History {
        revision: &operand.revision,
        limit: operand.limit,
        skip: operand.skip,
        max_output_bytes: operand.max_output_bytes,
    };
    history::validate(recipe, history)?;
    // A fixture keeps its trusted startup root; a production target admits
    // the request's own root (the server's project root for this target).
    let root = validate_path(
        root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        "",
        true,
    )?;
    let production = transport.facts.production();
    let template = match recipe {
        Recipe::Template(action) => templates::template(action),
        _ => None,
    };
    let remote = match template {
        Some(template) => {
            let args = templates::args(template, &operand.operands, root)?;
            Recipe::template_command(template, &args, root, production)
        }
        None if operand.operands.is_empty() => {
            recipe.command(root, &operand.paths, history, production)
        }
        None => return Err(ErrorCode::InvalidOperands),
    };
    let (timeout, stream_limit) = recipe.limits();
    let deadline = Instant::now() + timeout;
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", &transport.host, &remote]);
    let output =
        match process::run_with_combined_output_limit(pinned.command, deadline, 2 * stream_limit) {
            Ok(output) => output,
            // A mutation that lost its bounded reply may already have changed the repository.
            Err(process::Failure::TimedOut | process::Failure::Io) if recipe.is_mutation() => {
                return Ok(ambiguous());
            }
            Err(process::Failure::TimedOut) => return Err(ErrorCode::WorkspaceReadFailed),
            Err(process::Failure::Spawn) => return Err(ErrorCode::OwnerUnavailable),
            Err(process::Failure::Io) => return Err(ErrorCode::TransportLost),
        };
    if matches!(recipe, Recipe::CommitFileDiff) {
        return decode_capped(output, stream_limit, operand.max_output_bytes as usize);
    }
    if let Some(cap) = template.and_then(|template| template.cap) {
        return decode_capped(output, stream_limit, cap as usize);
    }
    decode(output, stream_limit)
}

/// The capped file diff: more than `cap` bytes is a flagged cut, not a failure.
fn decode_capped(
    mut output: process::Output,
    stream_limit: usize,
    cap: usize,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    if output.stdout.len() <= cap {
        return decode(output, stream_limit);
    }
    output.stdout.truncate(cap);
    if output.truncated || output.stderr.len() > stream_limit {
        return Err(ErrorCode::WorkspaceReadFailed);
    }
    Ok(ProofWorkspaceGitResult {
        code: Some(0),
        stdout: decode_text(&output.stdout),
        stderr: String::new(),
        outcome: Outcome::Unspecified as i32,
        stdout_truncated: true,
    })
}

fn ambiguous() -> ProofWorkspaceGitResult {
    ProofWorkspaceGitResult {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        outcome: Outcome::OutcomeUnknown as i32,
        stdout_truncated: false,
    }
}

fn decode(
    output: process::Output,
    stream_limit: usize,
) -> Result<ProofWorkspaceGitResult, ErrorCode> {
    let code = match output.status.code() {
        // Reserved shell guard/exec failures are not Git exits. The selected
        // builtins use zero or Git's fatal/usage exit codes.
        Some(3) => return Err(ErrorCode::WorkspacePathDenied),
        Some(4 | 126 | 127) => return Err(ErrorCode::WorkspaceReadFailed),
        Some(255) => return Err(ssh_failure(&output.stderr)),
        None => return Err(ErrorCode::TransportLost),
        Some(code) => code,
    };
    if output.truncated || output.stdout.len() > stream_limit || output.stderr.len() > stream_limit
    {
        return Err(ErrorCode::WorkspaceReadFailed);
    }
    Ok(ProofWorkspaceGitResult {
        code: Some(code),
        stdout: decode_text(&output.stdout),
        stderr: decode_text(&output.stderr),
        outcome: Outcome::Unspecified as i32,
        stdout_truncated: false,
    })
}

fn decode_text(bytes: &[u8]) -> String {
    // Match the app's UTF-8 TextDecoder (replacement for invalid bytes, with
    // an initial BOM consumed). Limits are on bytes before decoding.
    let bytes = match bytes.strip_prefix(b"\xef\xbb\xbf") {
        Some(text) => text,
        None => bytes,
    };
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
#[path = "git.tests.rs"]
mod tests;

#[cfg(test)]
#[path = "git.mutation.tests.rs"]
mod mutation_tests;

#[cfg(test)]
#[path = "git.production.tests.rs"]
mod production_tests;

#[cfg(test)]
#[path = "git.history.tests.rs"]
mod history_tests;

#[cfg(test)]
#[path = "git.templates.tests.rs"]
mod templates_tests;
