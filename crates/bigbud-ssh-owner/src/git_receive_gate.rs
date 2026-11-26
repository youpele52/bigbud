//! Admission of one tracked-branch receive-pack command before any pack is forwarded.
//!
//! This is a protocol guard, not a writable SSH route. A conductor must derive the
//! old OID from the exact bound server advertisement, revalidate its lease and
//! destination, then forward these bytes once. No Git process is started here.

use std::{
    collections::BTreeSet,
    io::{self, Read},
};

#[path = "git_receive_gate.conductor.rs"]
mod conductor;
#[path = "git_receive_gate.report.rs"]
mod report;
pub use conductor::{
    AdvertisedReceive, BoundTrackedReceive, ForwardedTrackedReceive, TrackedReceiveError,
    bind_advertised, observe_unchanged,
};
pub use report::{DestinationReceipt, PushReceipt, read_receive_report, summarize_push_receipts};

const MAX_COMMAND_BYTES: usize = 4096;
const FLUSH: &[u8; 4] = b"0000";

#[derive(Debug, PartialEq, Eq)]
pub enum ReceiveGateError {
    InvalidApproval,
    MalformedCommand,
    CommandTooLarge,
    RefusedUpdate,
    UnsupportedCapabilities,
    ExtraCommand,
    Io(io::ErrorKind),
}

/// The advertised old OID is trusted only when derived from the same pinned
/// destination and generation that will receive the update.
pub struct ApprovedTrackedUpdate<'a> {
    pub destination_ref: &'a str,
    pub advertised_old_oid: &'a str,
    pub approved_source_oid: &'a str,
}

impl ApprovedTrackedUpdate<'_> {
    pub fn validate(&self) -> Result<(), ReceiveGateError> {
        check_approval(self)
    }

    /// U15 first publish: an all-zero old OID of the source's width, a valid
    /// branch ref and a nonzero source. Only the production advertised binding
    /// admits it, and only when the live advertisement lacks the ref.
    pub fn validate_creation(&self) -> Result<(), ReceiveGateError> {
        check_creation(self)
    }
}

fn check_creation(approval: &ApprovedTrackedUpdate<'_>) -> Result<(), ReceiveGateError> {
    let zero = approval.advertised_old_oid.len() == approval.approved_source_oid.len()
        && approval.advertised_old_oid.bytes().all(|byte| byte == b'0');
    let formats = check_approval(&ApprovedTrackedUpdate {
        advertised_old_oid: approval.approved_source_oid,
        ..*approval
    });
    if zero && formats.is_ok() {
        Ok(())
    } else {
        Err(ReceiveGateError::InvalidApproval)
    }
}

/// Read exactly one command packet and its flush boundary before permitting forwarding.
/// On success, the returned bytes are the original validated wire prefix; the reader's
/// pack bytes remain unread. On failure, retire the attempted transport, do not retry.
pub fn authorize_receive_prefix(
    reader: &mut impl Read,
    approval: ApprovedTrackedUpdate<'_>,
) -> Result<Vec<u8>, ReceiveGateError> {
    authorize_prefix(reader, approval, false)
}

/// `creation` admits the all-zero old OID of a first publish (production only).
fn authorize_prefix(
    reader: &mut impl Read,
    approval: ApprovedTrackedUpdate<'_>,
    creation: bool,
) -> Result<Vec<u8>, ReceiveGateError> {
    if creation {
        check_creation(&approval)?;
    } else {
        check_approval(&approval)?;
    }
    let mut header = [0; 4];
    read(reader, &mut header)?;
    let len = packet_length(header).ok_or(ReceiveGateError::MalformedCommand)?;
    if len < 5 {
        return Err(ReceiveGateError::MalformedCommand);
    }
    if len - 4 > MAX_COMMAND_BYTES {
        return Err(ReceiveGateError::CommandTooLarge);
    }
    let mut body = vec![0; len - 4];
    read(reader, &mut body)?;
    check_command(&body, &approval)?;
    let mut next = [0; 4];
    read(reader, &mut next)?;
    if &next != FLUSH {
        return Err(ReceiveGateError::ExtraCommand);
    }
    let mut prefix = Vec::with_capacity(len + FLUSH.len());
    prefix.extend(header);
    prefix.extend(body);
    prefix.extend(FLUSH);
    Ok(prefix)
}

fn read(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), ReceiveGateError> {
    reader
        .read_exact(bytes)
        .map_err(|error| ReceiveGateError::Io(error.kind()))
}

fn packet_length(header: [u8; 4]) -> Option<usize> {
    header.into_iter().try_fold(0, |total, byte| {
        let nibble = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => return None,
        };
        Some(16 * total + usize::from(nibble))
    })
}

fn check_approval(approval: &ApprovedTrackedUpdate<'_>) -> Result<(), ReceiveGateError> {
    let oid = |text: &str| {
        matches!(text.len(), 40 | 64)
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            && text.bytes().any(|b| b != b'0')
    };
    let reference = approval.destination_ref;
    let valid_ref = reference.len() <= 255
        && reference.strip_prefix("refs/heads/").is_some_and(|name| {
            !name.is_empty()
                && !name.starts_with('-')
                && !name.contains("..")
                && name.split('/').all(|part| {
                    !part.is_empty()
                        && !part.starts_with('.')
                        && !part.ends_with('.')
                        && !part.ends_with(".lock")
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                })
        });
    if oid(approval.advertised_old_oid)
        && oid(approval.approved_source_oid)
        && approval.advertised_old_oid.len() == approval.approved_source_oid.len()
        && valid_ref
    {
        Ok(())
    } else {
        Err(ReceiveGateError::InvalidApproval)
    }
}

fn check_command(
    body: &[u8],
    approval: &ApprovedTrackedUpdate<'_>,
) -> Result<(), ReceiveGateError> {
    let text = std::str::from_utf8(body.strip_suffix(b"\n").unwrap_or(body))
        .map_err(|_| ReceiveGateError::MalformedCommand)?;
    let (update, caps) = text
        .split_once('\0')
        .ok_or(ReceiveGateError::MalformedCommand)?;
    let mut words = update.split(' ');
    if words.next() != Some(approval.advertised_old_oid)
        || words.next() != Some(approval.approved_source_oid)
        || words.next() != Some(approval.destination_ref)
        || words.next().is_some()
    {
        return Err(ReceiveGateError::RefusedUpdate);
    }
    check_capabilities(caps, approval.approved_source_oid.len())
}

fn check_capabilities(caps: &str, width: usize) -> Result<(), ReceiveGateError> {
    let mut values = BTreeSet::new();
    for cap in caps.strip_prefix(' ').unwrap_or(caps).split(' ') {
        let allowed = matches!(
            cap,
            "report-status" | "report-status-v2" | "side-band-64k" | "ofs-delta"
        ) || (width == 40 && cap == "object-format=sha1")
            || (width == 64 && cap == "object-format=sha256");
        if !allowed || !values.insert(cap) {
            return Err(ReceiveGateError::UnsupportedCapabilities);
        }
    }
    // A later conductor must consume the report and cannot infer success from EOF.
    if values.contains("report-status") == values.contains("report-status-v2")
        || (width == 64 && !values.contains("object-format=sha256"))
    {
        return Err(ReceiveGateError::UnsupportedCapabilities);
    }
    Ok(())
}

#[cfg(test)]
#[path = "git_receive_gate.tests.rs"]
mod tests;
