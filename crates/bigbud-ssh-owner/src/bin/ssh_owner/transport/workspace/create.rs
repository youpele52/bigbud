use super::{ErrorCode, Transport, process, quote, v1, validate_path};
use std::time::{Duration, Instant};
use v1::proof_workspace_create_result::Outcome;

const RECIPE: &str = include_str!("create_recipe.py");
const ACK_LIMIT: usize = b"BIGBUD_WORKSPACE_CREATE_V1 invalidRequest\n".len();

pub(in super::super::super) fn run(
    transport: &Transport,
    operand: &v1::ProofWorkspaceCreate,
) -> Result<v1::ProofWorkspaceCreateResult, ErrorCode> {
    let root = validate_path(
        transport.config.workspace_root.as_deref(),
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    let size = operand.contents.len();
    if size > super::write::MAX_CONTENT_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    let remote = format!(
        "/usr/bin/python3 -I -B -c {} {} {} {size}",
        quote(RECIPE),
        quote(root),
        quote(&operand.relative_path),
    );
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", transport.host(), &remote]);
    let output = process::run_with_input(
        pinned.command,
        Instant::now() + Duration::from_secs(30),
        ACK_LIMIT,
        &operand.contents,
    )
    .map_err(|error| match error {
        process::Failure::Spawn => ErrorCode::OwnerUnavailable,
        process::Failure::Io | process::Failure::TimedOut => ErrorCode::OutcomeUnknown,
    })?;
    decode(output)
}

fn decode(output: process::Output) -> Result<v1::ProofWorkspaceCreateResult, ErrorCode> {
    if output.truncated || !output.status.success() {
        return Err(ErrorCode::OutcomeUnknown);
    }
    let outcome = match output.stdout.as_slice() {
        b"BIGBUD_WORKSPACE_CREATE_V1 created\n" => Outcome::Created(v1::Empty {}),
        b"BIGBUD_WORKSPACE_CREATE_V1 alreadyExists\n" => Outcome::AlreadyExists(v1::Empty {}),
        b"BIGBUD_WORKSPACE_CREATE_V1 pathDenied\n" => return Err(ErrorCode::WorkspacePathDenied),
        b"BIGBUD_WORKSPACE_CREATE_V1 invalidRequest\n" => return Err(ErrorCode::InvalidOperands),
        _ => return Err(ErrorCode::OutcomeUnknown),
    };
    Ok(v1::ProofWorkspaceCreateResult {
        outcome: Some(outcome),
    })
}

#[cfg(test)]
#[test]
fn create_ack_requires_exact_marker_and_successful_exit() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    let reply = |status, stdout: &[u8], truncated| {
        decode(process::Output {
            status: ExitStatus::from_raw(status << 8),
            stdout: stdout.into(),
            stderr: vec![],
            truncated,
        })
    };
    let created = b"BIGBUD_WORKSPACE_CREATE_V1 created\n";
    assert!(matches!(
        reply(0, created, false).unwrap().outcome,
        Some(Outcome::Created(_))
    ));
    assert!(matches!(
        reply(0, b"BIGBUD_WORKSPACE_CREATE_V1 alreadyExists\n", false)
            .unwrap()
            .outcome,
        Some(Outcome::AlreadyExists(_))
    ));
    for result in [
        reply(0, b"", false),
        reply(255, created, false),
        reply(0, created, true),
        reply(0, &created[..created.len() - 1], false),
    ] {
        assert_eq!(result.unwrap_err(), ErrorCode::OutcomeUnknown);
    }
}
