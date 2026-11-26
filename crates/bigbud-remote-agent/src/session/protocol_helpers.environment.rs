//! Environment validation for process and PTY creates.
//!
//! - The remote validator (unchanged) admits the 22-name allowlist plus `LC_*` and
//!   `GIT_CONFIG_*`, uppercase names only, at most 64 entries.
//! - The local-launch validator (plan N1, F3) runs only on a `--local-desktop-host` host for a
//!   create with `local_launch = true`: any POSIX name, lowercase allowed, at most 512 entries
//!   and 256 KiB. Entries with an invalid name (an exported bash function such as
//!   `BASH_FUNC_x%%`) or a value over 16 KiB are skipped with only the name logged; a NUL byte
//!   or an exceeded cap fails the create.

use super::*;

const MAX_ENVIRONMENT_ENTRIES: usize = 64;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 16 * 1024;
const MAX_ENVIRONMENT_BYTES: usize = 256 * 1024;
const ALLOWED_ENVIRONMENT_NAMES: [&str; 22] = [
    "BIGBUD_TEST",
    "CI",
    "COLUMNS",
    "GIT_AUTHOR_DATE",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_DATE",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT",
    "LANG",
    "COLORTERM",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
];

pub(in crate::session::core) fn process_environment(
    request: &v1::ProcessRequest,
) -> Result<Vec<(String, String)>, SessionError> {
    process_environment_from_entries(&request.environment)
}

pub(in crate::session::core) fn process_environment_from_entries(
    entries: &[v1::ProcessEnvironment],
) -> Result<Vec<(String, String)>, SessionError> {
    if entries.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(SessionError::Process(
            "process environment contains too many entries".to_owned(),
        ));
    }
    let mut total_bytes = 0usize;
    entries
        .iter()
        .map(|entry| {
            let valid_name = !entry.name.is_empty()
                && entry.name.bytes().enumerate().all(|(index, byte)| {
                    (index == 0 && (byte == b'_' || byte.is_ascii_uppercase()))
                        || (index > 0
                            && (byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit()))
                });
            let allowed_name = is_allowed_environment_name(&entry.name);
            total_bytes = total_bytes.saturating_add(entry.name.len() + entry.value.len());
            if !valid_name
                || !allowed_name
                || entry.value.contains('\0')
                || entry.value.len() > MAX_ENVIRONMENT_VALUE_BYTES
                || total_bytes > MAX_ENVIRONMENT_BYTES
            {
                return Err(SessionError::Process(format!(
                    "environment entry '{}' is not permitted by the remote-agent policy",
                    entry.name
                )));
            }
            Ok((entry.name.clone(), entry.value.clone()))
        })
        .collect()
}

fn is_allowed_environment_name(name: &str) -> bool {
    ALLOWED_ENVIRONMENT_NAMES.contains(&name)
        || name.starts_with("LC_")
        || (name.starts_with("GIT_CONFIG_")
            && (name == "GIT_CONFIG_COUNT"
                || name.strip_prefix("GIT_CONFIG_KEY_").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                })
                || name
                    .strip_prefix("GIT_CONFIG_VALUE_")
                    .is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                    })))
}

const MAX_LOCAL_ENVIRONMENT_ENTRIES: usize = 512;

fn is_posix_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first == b'_' || first.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}

pub(in crate::session::core) fn validate_local_launch_environment(
    entries: &[v1::ProcessEnvironment],
) -> Result<Vec<(String, String)>, SessionError> {
    if entries.len() > MAX_LOCAL_ENVIRONMENT_ENTRIES {
        return Err(SessionError::Pty(
            "local launch environment contains too many entries".to_owned(),
        ));
    }
    let mut total_bytes = 0usize;
    let mut accepted = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.name.contains('\0') || entry.value.contains('\0') {
            return Err(SessionError::Pty(
                "local launch environment contains a NUL byte".to_owned(),
            ));
        }
        if !is_posix_name(&entry.name) || entry.value.len() > MAX_ENVIRONMENT_VALUE_BYTES {
            // Only the name is logged: values may hold secrets.
            eprintln!(
                "local launch environment entry skipped: {}",
                entry.name.escape_debug()
            );
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry.name.len() + entry.value.len());
        if total_bytes > MAX_ENVIRONMENT_BYTES {
            return Err(SessionError::Pty(
                "local launch environment exceeds 256 KiB".to_owned(),
            ));
        }
        accepted.push((entry.name.clone(), entry.value.clone()));
    }
    Ok(accepted)
}
