//! One-destination conductor building block. Its caller must own a deadline-bound,
//! pinned transport and refuse any non-fixture write until a launcher is qualified.

use super::{
    ApprovedTrackedUpdate, DestinationReceipt, FLUSH, MAX_COMMAND_BYTES, ReceiveGateError,
    authorize_prefix, check_approval, packet_length, read_receive_report, report,
};
use std::io::{self, Read, Write};

#[path = "git_receive_gate.advertised.rs"]
mod advertised;
pub use advertised::{AdvertisedReceive, bind_advertised};

#[derive(Debug, PartialEq, Eq)]
pub enum TrackedReceiveError {
    Gate(ReceiveGateError),
    AdvertisementIo(io::ErrorKind),
    InvalidAdvertisement,
    /// The live advertisement does not hold the approved old OID for the
    /// destination (moved or absent). Nothing was forwarded.
    StaleRef,
    StaleLease,
    /// I/O attempted after admission; the conductor must not replay it.
    UnconfirmedForward(io::ErrorKind),
}

/// Holds both halves of the same pinned channel privately. Neither the remote
/// writer nor the original capabilities are exposed before the prefix gate.
pub struct BoundTrackedReceive<'a, R, W> {
    remote_output: R,
    remote_input: W,
    approval: ApprovedTrackedUpdate<'a>,
    capabilities: Vec<&'static str>,
    advertisement: Vec<u8>,
    /// A first publish (production only): the old OID is all zeros.
    creation: bool,
}

impl<'a, R: Read, W: Write> BoundTrackedReceive<'a, R, W> {
    /// Only the approved tracked branch may appear in this fixture advertisement.
    /// In particular, missing/zero OIDs, branch creation, and stale old OIDs fail closed.
    pub fn bind(
        mut remote_output: R,
        remote_input: W,
        approval: ApprovedTrackedUpdate<'a>,
    ) -> Result<Self, TrackedReceiveError> {
        check_approval(&approval).map_err(TrackedReceiveError::Gate)?;
        if approval.advertised_old_oid == approval.approved_source_oid {
            return Err(TrackedReceiveError::Gate(ReceiveGateError::InvalidApproval));
        }
        let (capabilities, advertisement) = verified_advertisement(&mut remote_output, &approval)?;
        Ok(Self {
            remote_output,
            remote_input,
            approval,
            capabilities,
            advertisement,
            creation: false,
        })
    }

    /// Only capabilities understood by the fixture conductor are visible to Git.
    pub fn advertisement(&self) -> &[u8] {
        &self.advertisement
    }

    /// Revalidate the pinned destination/generation immediately before the first
    /// write. The caller must serialize that check with its lease's retirement.
    /// The client reader is left at the beginning of the pack on success.
    pub fn forward_prefix(
        mut self,
        client_input: &mut impl Read,
        revalidate: impl FnOnce() -> bool,
    ) -> Result<ForwardedTrackedReceive<'a, R, W>, TrackedReceiveError> {
        let destination_ref = self.approval.destination_ref;
        let prefix = authorize_prefix(client_input, self.approval, self.creation)
            .map_err(TrackedReceiveError::Gate)?;
        let requested = prefix
            .strip_suffix(FLUSH)
            .and_then(|packet| packet.get(4..))
            .and_then(|body| body.splitn(2, |byte| *byte == 0).nth(1))
            .ok_or(TrackedReceiveError::Gate(
                ReceiveGateError::MalformedCommand,
            ))?;
        let caps = requested.strip_suffix(b"\n").unwrap_or(requested);
        let caps = caps.strip_prefix(b" ").unwrap_or(caps);
        let mut sideband = false;
        for cap in caps.split(|byte| *byte == b' ') {
            if !self
                .capabilities
                .iter()
                .any(|offered| cap == offered.as_bytes())
            {
                return Err(TrackedReceiveError::Gate(
                    ReceiveGateError::UnsupportedCapabilities,
                ));
            }
            sideband |= cap == b"side-band-64k";
        }
        if !revalidate() {
            return Err(TrackedReceiveError::StaleLease);
        }
        self.remote_input
            .write_all(&prefix)
            .and_then(|()| self.remote_input.flush())
            .map_err(|error| TrackedReceiveError::UnconfirmedForward(error.kind()))?;
        Ok(ForwardedTrackedReceive {
            remote_output: self.remote_output,
            remote_input: self.remote_input,
            destination_ref,
            sideband,
        })
    }
}

/// Verify an already-matching tracked ref against the pinned advertisement.
/// There is deliberately no receiver writer in this API.
pub fn observe_unchanged(
    mut remote_output: impl Read,
    approval: ApprovedTrackedUpdate<'_>,
) -> Result<Vec<u8>, TrackedReceiveError> {
    check_approval(&approval).map_err(TrackedReceiveError::Gate)?;
    if approval.advertised_old_oid != approval.approved_source_oid {
        return Err(TrackedReceiveError::Gate(ReceiveGateError::InvalidApproval));
    }
    verified_advertisement(&mut remote_output, &approval).map(|(_, advertisement)| advertisement)
}

fn verified_advertisement(
    remote_output: &mut impl Read,
    approval: &ApprovedTrackedUpdate<'_>,
) -> Result<(Vec<&'static str>, Vec<u8>), TrackedReceiveError> {
    let mut header = [0; 4];
    read_advertisement(remote_output, &mut header)?;
    let len = packet_length(header).ok_or(TrackedReceiveError::InvalidAdvertisement)?;
    if !(5..=MAX_COMMAND_BYTES + 4).contains(&len) {
        return Err(TrackedReceiveError::InvalidAdvertisement);
    }
    let mut body = vec![0; len - 4];
    read_advertisement(remote_output, &mut body)?;
    let mut end = [0; 4];
    read_advertisement(remote_output, &mut end)?;
    if &end != FLUSH {
        return Err(TrackedReceiveError::InvalidAdvertisement);
    }
    let body = std::str::from_utf8(body.strip_suffix(b"\n").unwrap_or(&body))
        .map_err(|_| TrackedReceiveError::InvalidAdvertisement)?;
    let (reference, advertised) = body
        .split_once('\0')
        .ok_or(TrackedReceiveError::InvalidAdvertisement)?;
    let expected = format!(
        "{} {}",
        approval.advertised_old_oid, approval.destination_ref
    );
    if reference != expected {
        return Err(TrackedReceiveError::InvalidAdvertisement);
    }
    let capabilities = narrow_capabilities(advertised, approval.advertised_old_oid.len())?;
    let payload = format!("{expected}\0{}", capabilities.join(" "));
    let mut advertisement = format!("{:04x}{payload}", payload.len() + 4).into_bytes();
    advertisement.extend(FLUSH);
    Ok((capabilities, advertisement))
}

fn read_advertisement(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), TrackedReceiveError> {
    reader
        .read_exact(bytes)
        .map_err(|error| TrackedReceiveError::AdvertisementIo(error.kind()))
}

fn narrow_capabilities(raw: &str, width: usize) -> Result<Vec<&'static str>, TrackedReceiveError> {
    let raw = raw.strip_prefix(' ').unwrap_or(raw);
    let mut offered = std::collections::BTreeSet::new();
    for cap in raw.split(' ') {
        if cap.is_empty()
            || !cap.bytes().all(|byte| byte.is_ascii_graphic())
            || !offered.insert(cap)
        {
            return Err(TrackedReceiveError::InvalidAdvertisement);
        }
    }
    let format = if width == 40 {
        "object-format=sha1"
    } else {
        "object-format=sha256"
    };
    if !offered.contains("report-status")
        || (width == 64 && !offered.contains(format))
        || offered
            .iter()
            .any(|cap| cap.starts_with("object-format=") && *cap != format)
    {
        return Err(TrackedReceiveError::InvalidAdvertisement);
    }
    Ok(["report-status", "side-band-64k", "ofs-delta", format]
        .into_iter()
        .filter(|cap| offered.contains(cap))
        .collect())
}

/// Pack input is accessible only after one exact command and its flush passed.
/// The caller owns bounded pack transfer and must retire this channel on error.
pub struct ForwardedTrackedReceive<'a, R, W> {
    remote_output: R,
    remote_input: W,
    destination_ref: &'a str,
    sideband: bool,
}

impl<R: Read, W: Write> ForwardedTrackedReceive<'_, R, W> {
    pub fn pack_sink(&mut self) -> &mut W {
        &mut self.remote_input
    }

    /// Call only after successfully forwarding the pack. The pinned reader must
    /// have a deadline; bytes and parser work are bounded here, not wait time.
    /// A missing/truncated/malformed report is unknown, even on clean EOF.
    #[must_use]
    pub fn receive_report(self) -> DestinationReceipt {
        self.exchange_pack(|remote_output, mut remote_input, limit| {
            remote_input.flush()?;
            drop(remote_input);
            let mut raw = Vec::new();
            remote_output
                .take((limit + 1) as u64)
                .read_to_end(&mut raw)?;
            Ok(raw)
        })
        .0
    }

    /// Drive the admitted pack and simultaneously collect the complete reply.
    /// The caller must enforce its transport deadlines and the provided reply
    /// cap during I/O; only a confirmed report may be forwarded to Git.
    #[must_use]
    pub fn exchange_pack(
        self,
        exchange: impl FnOnce(R, W, usize) -> io::Result<Vec<u8>>,
    ) -> (DestinationReceipt, Vec<u8>) {
        let limit = if self.sideband {
            report::SIDEBAND_LIMIT
        } else {
            report::LIMIT
        };
        let Ok(raw) = exchange(self.remote_output, self.remote_input, limit) else {
            return (DestinationReceipt::Unconfirmed, Vec::new());
        };
        let receipt = if self.sideband {
            report::read_sideband_report(&raw, self.destination_ref)
        } else {
            read_receive_report(&raw, self.destination_ref)
        };
        if receipt == DestinationReceipt::Unconfirmed {
            (receipt, Vec::new())
        } else {
            (receipt, raw)
        }
    }
}

#[cfg(test)]
#[path = "git_receive_gate.conductor.tests.rs"]
mod tests;
