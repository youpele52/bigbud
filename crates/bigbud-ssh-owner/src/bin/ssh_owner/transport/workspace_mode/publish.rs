use super::{
    ErrorCode, Inspection, MAX_GENERATION, OUTPUT_MAX, Publication, STDERR_MAX, TIMEOUT, Transport,
    configured_root, hex_digest, parse, process, require_exact_root, shell_command, valid_record,
    valid_root,
};
use sha2::{Digest, Sha256};
use std::time::Instant;

const SCRIPT: &str = concat!(
    "inspect() {\n",
    include_str!("inspect.sh"),
    "\n}\n",
    include_str!("publish.sh"),
);
const COMPARE: &[u8] = b"bigbud.workspace-mode.publish.v1 compare\n";
const COMPARE_END: &[u8] = b"\nbigbud.workspace-mode.publish.v1 end\n";

impl Transport {
    /// The dispatcher admits the exact publish grant in the current owner generation and binds
    /// `observed` to its trusted inspection for this target and root. Never replay a launched CAS.
    pub(in super::super::super) fn publish_workspace_mode(
        &self,
        requested_root: &str,
        observed: &Inspection,
        next_record: &str,
    ) -> Result<Publication, ErrorCode> {
        let deadline = Instant::now() + TIMEOUT;
        let remote = command(
            self.config
                .workspace_root
                .as_deref()
                .and_then(configured_root),
            requested_root,
            observed,
            next_record,
        )?;
        self.revalidate_policy()?;
        let mut pinned = self.pinned_ssh("-T")?;
        pinned.command.args(["--", &self.host, &remote]);
        match process::run(
            pinned.command,
            deadline,
            OUTPUT_MAX + COMPARE.len() + COMPARE_END.len(),
        ) {
            Ok(output) => Ok(decode(output, observed)),
            Err(process::Failure::Spawn) => Err(ErrorCode::OwnerUnavailable),
            Err(process::Failure::TimedOut | process::Failure::Io) => Ok(Publication::Uncertain),
        }
    }
}

fn command(
    approved: Option<&str>,
    requested: &str,
    observed: &Inspection,
    next_record: &str,
) -> Result<String, ErrorCode> {
    require_exact_root(approved, requested)?;
    let invalid = ErrorCode::InvalidOperands;
    let Inspection::Ready {
        physical_root,
        host_identity,
        account_uid,
        realpath_sha256,
        generation,
        current_record,
    } = observed
    else {
        return Err(invalid);
    };
    let host = host_identity
        .strip_prefix("machine-v1:")
        .filter(|host| hex_digest(host))
        .ok_or(invalid)?;
    let next = generation
        .checked_add(1)
        .filter(|n| *n <= MAX_GENERATION)
        .ok_or(invalid)?;
    if !valid_root(physical_root)
        || format!("{:x}", Sha256::digest(physical_root)) != *realpath_sha256
    {
        return Err(invalid);
    }
    let previous = match (*generation, current_record.as_deref()) {
        (0, None) => "",
        (n @ 1.., Some(raw))
            if valid_record(raw, host_identity, *account_uid, realpath_sha256, n)
                && raw.ends_with("\"mode\":\"laptop-runtime\",\"owner\":null}") =>
        {
            raw
        }
        _ => return Err(invalid),
    };
    if !valid_record(
        next_record,
        host_identity,
        *account_uid,
        realpath_sha256,
        next,
    ) || !next_record.contains("\"mode\":\"laptop-runtime\",\"owner\":\"")
    {
        return Err(invalid);
    }
    Ok(shell_command(
        SCRIPT,
        &[
            requested,
            physical_root,
            host,
            &account_uid.to_string(),
            realpath_sha256,
            &generation.to_string(),
            previous,
            next_record,
        ],
    ))
}

fn decode(output: process::Output, observed: &Inspection) -> Publication {
    use Publication::*;
    if !output.status.success() || output.truncated || output.stderr.len() >= STDERR_MAX {
        return Uncertain;
    }
    match output.stdout.as_slice() {
        b"bigbud.workspace-mode.publish.v1 committed\n" => Committed,
        b"bigbud.workspace-mode.publish.v1 not-linux\n" => NotLinux,
        b"bigbud.workspace-mode.publish.v1 no-machine-id\n" => NoMachineId,
        b"bigbud.workspace-mode.publish.v1 missing-folder\n" => MissingFolder,
        b"bigbud.workspace-mode.publish.v1 unsafe-storage\n" => UnsafeStorage,
        b"bigbud.workspace-mode.publish.v1 scope-changed\n" => ScopeChanged,
        other => other
            .strip_prefix(COMPARE)
            .and_then(|bytes| bytes.strip_suffix(COMPARE_END))
            .map_or(Uncertain, |actual| compare(actual, observed)),
    }
}

fn compare(actual: &[u8], observed: &Inspection) -> Publication {
    let Inspection::Ready {
        physical_root,
        host_identity,
        account_uid,
        realpath_sha256,
        generation,
        ..
    } = observed
    else {
        return Publication::Uncertain;
    };
    match parse(actual) {
        Ok(Inspection::Ready {
            physical_root: root,
            host_identity: host,
            account_uid: uid,
            realpath_sha256: digest,
            generation: latest,
            ..
        }) => {
            if root != *physical_root
                || host != *host_identity
                || uid != *account_uid
                || digest != *realpath_sha256
            {
                Publication::ScopeChanged
            } else if latest > *generation {
                Publication::Conflict
            } else {
                Publication::UnsafeStorage
            }
        }
        _ => Publication::UnsafeStorage,
    }
}

#[cfg(test)]
#[path = "publish.tests.rs"]
mod tests;
