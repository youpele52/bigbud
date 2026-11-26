//! Operand rules for `agent_control`, mirroring the legacy TypeScript
//! validators (`validateRemoteAgentRuntime`, the launch, fence and reservation
//! id patterns). Every accepted operand is a quote-safe data word; the
//! generated template binds it once and rechecks the layout on the host.

use crate::v1::{AgentRuntime, AgentRuntimeOrigin, ErrorCode};

const TARGET_TRIPLES: [&str; 4] = [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
];
const MAX_PATH_BYTES: usize = 4095;

pub(super) fn check(valid: bool) -> Result<(), ErrorCode> {
    if valid {
        Ok(())
    } else {
        Err(ErrorCode::InvalidOperands)
    }
}

fn all(value: &str, allowed: impl Fn(u8) -> bool) -> bool {
    value.bytes().all(allowed)
}

/// `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`
pub(super) fn version(value: &str) -> bool {
    value.len() <= 64
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && all(value, |b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-')
        })
}

pub(super) fn sha256(value: &str) -> bool {
    value.len() == 64 && all(value, |b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

/// `^[A-Za-z0-9-]{min,max}$`
pub(super) fn id(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && all(value, |b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `^[\x21-\x7e]+$`, bounded like the remote epoch file.
pub(super) fn printable(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len()) && all(value, |b| (0x21..=0x7e).contains(&b))
}

/// Absolute, normalized (no empty, `.` or `..` component, no trailing slash)
/// and free of control bytes, like `posix.normalize(path) === path`.
pub(super) fn exact_path(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('/') else {
        return false;
    };
    value.len() <= MAX_PATH_BYTES
        && !rest.is_empty()
        && !value.chars().any(char::is_control)
        && rest.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

pub(super) fn no_whitespace(value: &str) -> bool {
    !value.chars().any(char::is_whitespace)
}

/// The runtime as ten positional operands, after the legacy runtime rules.
pub(crate) fn runtime(runtime: &AgentRuntime) -> Result<Vec<String>, ErrorCode> {
    let generation = &runtime.generation;
    check(
        (1..=32).contains(&generation.len())
            && all(generation, |b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
            }),
    )?;
    check(version(&runtime.version) && sha256(&runtime.sha256))?;
    check(printable(&runtime.build_digest, 256))?;
    check(TARGET_TRIPLES.contains(&runtime.target_triple.as_str()))?;
    for path in [
        &runtime.binary_path,
        &runtime.state_path,
        &runtime.socket_path,
        &runtime.log_path,
    ] {
        check(exact_path(path))?;
    }
    let origin = match AgentRuntimeOrigin::try_from(runtime.origin) {
        Ok(AgentRuntimeOrigin::Managed) => "managed",
        Ok(AgentRuntimeOrigin::LegacyExternal) => "legacy-external",
        _ => return Err(ErrorCode::InvalidOperands),
    };
    Ok(vec![
        runtime.generation.clone(),
        runtime.version.clone(),
        runtime.sha256.clone(),
        runtime.build_digest.clone(),
        runtime.target_triple.clone(),
        runtime.binary_path.clone(),
        runtime.state_path.clone(),
        runtime.socket_path.clone(),
        runtime.log_path.clone(),
        origin.to_owned(),
    ])
}

pub(super) fn managed(runtime: &AgentRuntime) -> bool {
    runtime.origin == AgentRuntimeOrigin::Managed as i32
}
