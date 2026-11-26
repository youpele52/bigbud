//! One bounded, redacted JSON Lines event for fixture startup stderr.

use super::diagnostic::{ConfigFailure, SourceClass};
use super::{ErrorCode, source::MAX_CONFIG};
use serde_json::{Map, json};
use std::io::{self, Write};

pub(super) const MAX_RECORD_BYTES: usize = 512;

/// Stderr is best-effort: a closed sink must not mask or change the rejection.
pub(super) fn report_rejection(failure: ConfigFailure, stderr: impl Write) -> ErrorCode {
    if failure.code == ErrorCode::ConfigUnsupported {
        let _ = write_record(&failure, stderr);
    }
    failure.code
}

fn write_record(failure: &ConfigFailure, mut stderr: impl Write) -> io::Result<()> {
    // A line requires at least one byte in the individual source file. Omit
    // impossible locations rather than reporting a fabricated line number.
    let diagnostic = failure
        .diagnostic
        .filter(|site| (1..=MAX_CONFIG).contains(&(site.line as u64)));
    let location = diagnostic.map(|site| {
        let mut location = Map::from_iter([
            ("directive".into(), json!(site.directive.identifier())),
            ("source".into(), json!(source_id(site.source))),
            ("line".into(), json!(site.line)),
        ]);
        if let Some(hop) = failure.jump_hop {
            location.insert("hop".into(), json!(hop));
        }
        location
    });
    let remedy = diagnostic.map_or(
        "Check the selected owner-private fixture config and its required settings.",
        |site| site.remedy(),
    );
    let mut record = serde_json::to_vec(&json!({
        "event": "ssh_owner_alias_policy_rejected",
        "version": 1,
        "code": "config_unsupported",
        "location": location,
        "remedy": remedy,
    }))?;
    if record.len() >= MAX_RECORD_BYTES {
        return Err(io::Error::other("startup diagnostic exceeds byte limit"));
    }
    record.push(b'\n');
    stderr.write_all(&record)
}

const fn source_id(source: SourceClass) -> &'static str {
    match source {
        SourceClass::UserConfig => "user_config",
        SourceClass::UserInclude => "user_include",
        SourceClass::SystemConfig => "system_config",
        SourceClass::SystemInclude => "system_include",
    }
}
