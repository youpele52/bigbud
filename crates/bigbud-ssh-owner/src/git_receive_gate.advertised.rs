//! U15 production binding over a complete v0 receive-pack advertisement.
//!
//! A real repository advertises every ref. The owner reads all of them from its
//! own pinned channel, requires exactly one entry for the approved destination
//! at the approved old OID, and gives local Git a synthesized single-ref
//! advertisement carrying only the conductor's narrowed capabilities. A moved
//! or absent ref is `StaleRef`; nothing is written to receive-pack before the
//! command-prefix gate admits the exact approved update.

use super::super::{ApprovedTrackedUpdate, FLUSH, check_approval, check_creation, packet_length};
use super::{BoundTrackedReceive, TrackedReceiveError, narrow_capabilities, read_advertisement};
use std::io::{Read, Write};

/// Total advertisement bytes the owner reads before refusing.
const ADVERTISEMENT_LIMIT: usize = 16 * 1024 * 1024;
/// Largest pkt-line Git writes.
const PACKET_LIMIT: usize = 65_520;
const NO_REFS: &str = "capabilities^{}";
/// Live tips offered to local Git as `.have` for a first publish, so it can
/// send a thin pack instead of the whole history.
const MAX_HAVES: usize = 256;

pub enum AdvertisedReceive<'a, R, W> {
    /// The live ref is at the approved old OID and the approved source differs.
    Update(BoundTrackedReceive<'a, R, W>),
    /// The approved old and source OIDs are equal and the live ref matches.
    /// Give local Git this advertisement and write nothing.
    Unchanged(Vec<u8>),
}

/// Read the whole advertisement before any write. On success the remote reader
/// is positioned after the advertisement's flush. An all-zero old OID is a
/// first publish: the destination must be absent (present is `StaleRef`), and
/// only `<zero> <source> <ref>` is then admitted.
pub fn bind_advertised<'a, R: Read, W: Write>(
    mut remote_output: R,
    remote_input: W,
    approval: ApprovedTrackedUpdate<'a>,
) -> Result<AdvertisedReceive<'a, R, W>, TrackedReceiveError> {
    let creation = approval.advertised_old_oid.bytes().all(|byte| byte == b'0');
    if creation {
        check_creation(&approval)
    } else {
        check_approval(&approval)
    }
    .map_err(TrackedReceiveError::Gate)?;
    let width = approval.advertised_old_oid.len();
    let (live, capabilities, haves) = scan(&mut remote_output, approval.destination_ref, width)?;
    if creation {
        if live.is_some() {
            return Err(TrackedReceiveError::StaleRef);
        }
        // As receive-pack writes it: capabilities ride on the first `.have`
        // line; `capabilities^{}` only when there is nothing else (Git accepts
        // nothing but `shallow` after that placeholder).
        let mut lines = haves.iter().map(|oid| format!("{oid} .have"));
        let first = lines
            .next()
            .unwrap_or_else(|| format!("{} {NO_REFS}", approval.advertised_old_oid));
        let mut advertisement = Vec::new();
        for line in std::iter::once(format!("{first}\0{}", capabilities.join(" "))).chain(lines) {
            let line = format!("{line}\n");
            advertisement.extend(format!("{:04x}{line}", line.len() + 4).into_bytes());
        }
        advertisement.extend(FLUSH);
        return Ok(AdvertisedReceive::Update(BoundTrackedReceive {
            remote_output,
            remote_input,
            approval,
            capabilities,
            advertisement,
            creation: true,
        }));
    }
    if live.as_deref() != Some(approval.advertised_old_oid) {
        return Err(TrackedReceiveError::StaleRef);
    }
    let payload = format!(
        "{} {}\0{}",
        approval.advertised_old_oid,
        approval.destination_ref,
        capabilities.join(" ")
    );
    let mut advertisement = format!("{:04x}{payload}", payload.len() + 4).into_bytes();
    advertisement.extend(FLUSH);
    if approval.advertised_old_oid == approval.approved_source_oid {
        return Ok(AdvertisedReceive::Unchanged(advertisement));
    }
    Ok(AdvertisedReceive::Update(BoundTrackedReceive {
        remote_output,
        remote_input,
        approval,
        capabilities,
        advertisement,
        creation: false,
    }))
}

type Scan = (Option<String>, Vec<&'static str>, Vec<String>);

fn scan(
    reader: &mut impl Read,
    destination: &str,
    width: usize,
) -> Result<Scan, TrackedReceiveError> {
    let invalid = || TrackedReceiveError::InvalidAdvertisement;
    let mut total = 0;
    let mut capabilities = None;
    let mut live = None;
    let mut haves = std::collections::BTreeSet::new();
    loop {
        let mut header = [0; 4];
        read_advertisement(reader, &mut header)?;
        let len = packet_length(header).ok_or_else(invalid)?;
        if len == 0 {
            // A flush ends the advertisement; an empty one has no capabilities.
            let capabilities = capabilities.ok_or_else(invalid)?;
            return Ok((live, capabilities, haves.into_iter().collect()));
        }
        total += len;
        if !(5..=PACKET_LIMIT).contains(&len) || total > ADVERTISEMENT_LIMIT {
            return Err(invalid());
        }
        let mut body = vec![0; len - 4];
        read_advertisement(reader, &mut body)?;
        let line = std::str::from_utf8(body.strip_suffix(b"\n").unwrap_or(&body))
            .map_err(|_| invalid())?;
        let entry = if capabilities.is_none() {
            let (entry, offered) = line.split_once('\0').ok_or_else(invalid)?;
            capabilities = Some(narrow_capabilities(offered, width)?);
            entry
        } else if line.contains('\0') {
            return Err(invalid());
        } else {
            line
        };
        if let Some(oid) = entry.strip_prefix("shallow ") {
            // A shallow remote advertises its grafts; they name no ref.
            if !is_oid(oid, width) {
                return Err(invalid());
            }
            continue;
        }
        let (oid, name) = entry.split_once(' ').ok_or_else(invalid)?;
        if !is_oid(oid, width) || name.is_empty() || name.contains(' ') {
            return Err(invalid());
        }
        if name == NO_REFS {
            // Only an empty repository advertises this placeholder, once, first.
            if total != len || oid.bytes().any(|byte| byte != b'0') {
                return Err(invalid());
            }
        } else if name == destination {
            if live.is_some() {
                return Err(invalid());
            }
            live = Some(oid.to_owned());
        } else if haves.len() < MAX_HAVES {
            haves.insert(oid.to_owned());
        }
    }
}

fn is_oid(text: &str, width: usize) -> bool {
    text.len() == width
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
#[path = "git_receive_gate.advertised.tests.rs"]
mod tests;
