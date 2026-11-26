use super::{
    ErrorCode, Transport, process, quote, run, ssh_failure, v1, validate_path, workspace_command,
};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use v1::{ProofWorkspaceContentMatches, ProofWorkspaceContentSearch, ProofWorkspaceMatch};

const TIMEOUT: Duration = Duration::from_secs(10);
const CAPTURE_LIMIT: usize = 512 * 1024;
const MAX_QUERY_LENGTH: usize = 256;
const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".convex",
    "node_modules",
    ".next",
    ".turbo",
    "dist",
    "build",
    "out",
    ".cache",
];
const START: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
PATH=/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin
export PATH
command -v rg >/dev/null 2>&1 || exit 127
# rg does not follow search-result symlinks by default, but opens ignore files
# separately. Reject linked or special ignore files before handing over the tree.
# Like the normal workspace path walk, this is not a remote race guarantee.
unsafe_ignore=$(/usr/bin/find . \( -name .gitignore -o -name .ignore -o -name .rgignore \) ! -type f -print -quit) || exit 3
[ -z "$unsafe_ignore" ] || exit 3
exec /usr/bin/env -i PATH="$PATH" LC_ALL=C rg --no-config --no-ignore-global --no-ignore-parent --no-ignore-exclude --json --hidden --ignore-case --fixed-strings"#;

pub(in super::super) fn search(
    transport: &Transport,
    operand: &ProofWorkspaceContentSearch,
) -> Result<ProofWorkspaceContentMatches, ErrorCode> {
    let root = validate_path(
        super::root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        "",
        true,
    )?;
    let remote = command(root, &operand.query)?;
    decode(
        run(transport, &remote, TIMEOUT, CAPTURE_LIMIT)?,
        root,
        operand.limit,
    )
}

fn command(root: &str, query: &str) -> Result<String, ErrorCode> {
    // A newline would let rg treat one argument as multiple patterns even
    // in fixed-string mode. Keep the legacy UI's query length bound.
    if query.trim().is_empty()
        || query.contains(['\0', '\r', '\n'])
        || query.encode_utf16().take(MAX_QUERY_LENGTH + 1).count() > MAX_QUERY_LENGTH
    {
        return Err(ErrorCode::InvalidOperands);
    }
    let mut script = START.to_owned();
    for directory in EXCLUDED_DIRECTORIES {
        script.push_str(&format!(" --glob '!**/{directory}/**'"));
    }
    script.push_str(" -- \"$3\" .\n");
    Ok(format!(
        "{} {}",
        workspace_command(&script, root, ""),
        quote(query)
    ))
}

fn decode(
    output: process::Output,
    root: &str,
    limit: u32,
) -> Result<ProofWorkspaceContentMatches, ErrorCode> {
    match output.status.code() {
        Some(0 | 1) => parse(&output.stdout, output.truncated, root, limit),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(127) => Err(ErrorCode::ProofRipgrepUnavailable),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn parse(
    bytes: &[u8],
    capture_truncated: bool,
    root: &str,
    limit: u32,
) -> Result<ProofWorkspaceContentMatches, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let mut result = ProofWorkspaceContentMatches {
        matches: Vec::new(),
        truncated: capture_truncated,
    };
    for raw in bytes.split_inclusive(|&byte| byte == b'\n') {
        let Some(record) = raw.strip_suffix(b"\n") else {
            if capture_truncated {
                break;
            }
            return Err(failed);
        };
        let record: Value = serde_json::from_slice(record).map_err(|_| failed)?;
        match record.get("type").and_then(Value::as_str) {
            Some("match") => {
                if let Some(entry) = parse_match(record.get("data").ok_or(failed)?, root)? {
                    if result.matches.len() < limit as usize {
                        result.matches.push(entry);
                    } else {
                        result.truncated = true;
                    }
                }
            }
            Some("begin" | "end" | "summary") => {}
            _ => return Err(failed),
        }
    }
    Ok(result)
}

fn parse_match(data: &Value, root: &str) -> Result<Option<ProofWorkspaceMatch>, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let (Some(path), Some(line_text)) = (
        rg_text(data.get("path").ok_or(failed)?)?,
        rg_text(data.get("lines").ok_or(failed)?)?,
    ) else {
        // rg represents non-UTF-8 paths or lines as bytes; the wire reply
        // cannot represent those losslessly.
        return Ok(None);
    };
    let path = path.strip_prefix("./").unwrap_or(path);
    validate_path(Some(Path::new(root)), root, path, false).map_err(|_| failed)?;
    if path.contains('\\')
        || path.rsplit_once('/').is_some_and(|(directories, _)| {
            directories
                .split('/')
                .any(|part| EXCLUDED_DIRECTORIES.contains(&part))
        })
    {
        return Err(failed);
    }
    let line = data
        .get("line_number")
        .and_then(Value::as_u64)
        .filter(|&line| line > 0)
        .ok_or(failed)?;
    let line_text = match line_text.strip_suffix('\n') {
        Some(text) => text.strip_suffix('\r').unwrap_or(text),
        None => line_text,
    };
    let submatches = data
        .get("submatches")
        .and_then(Value::as_array)
        .ok_or(failed)?;
    let column = match submatches.first() {
        Some(first) => {
            let start = first.get("start").and_then(Value::as_u64).ok_or(failed)?;
            let end = first.get("end").and_then(Value::as_u64).ok_or(failed)?;
            if start >= end || end > line_text.len() as u64 {
                return Err(failed);
            }
            Some(u32::try_from(start + 1).map_err(|_| failed)?) // rg reports UTF-8 byte offsets.
        }
        None => None,
    };
    Ok(Some(ProofWorkspaceMatch {
        path: path.to_owned(),
        line,
        column,
        line_text: line_text.to_owned(),
    }))
}

fn rg_text(field: &Value) -> Result<Option<&str>, ErrorCode> {
    match (field.get("text"), field.get("bytes")) {
        (Some(Value::String(text)), None) => Ok(Some(text)),
        (None, Some(Value::String(_))) => Ok(None),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

#[cfg(test)]
mod tests;
