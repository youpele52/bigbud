//! Classification of a complete inner receive-pack report after the conductor
//! separates any negotiated sideband. A status belongs only to the exact pinned
//! destination and the single ref admitted by the command-prefix guard.

use super::{FLUSH, packet_length};

pub(super) const LIMIT: usize = 8 * 1024;
pub(super) const SIDEBAND_LIMIT: usize = 256 * 1024;
const SIDEBAND_PACKET_LIMIT: usize = 65_520;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DestinationReceipt {
    /// `ok <expected-ref>` with successful unpack and a complete report.
    Accepted,
    /// Trusted local observation of an already matching ref, with no write attempted.
    Unchanged,
    /// `ng <expected-ref>` with a complete report, after one exact update was admitted.
    Rejected,
    Unconfirmed,
}

#[derive(Debug, Eq, PartialEq)]
pub enum PushReceipt {
    AllAccepted,
    UpToDate,
    Rejected,
    Partial,
    Unconfirmed,
}

/// Accept only the narrow, complete status shape. No rank is inferred from a
/// shell exit, transport EOF, unpack failure, extra ref, or report-v2 options.
#[must_use]
pub fn read_receive_report(report: &[u8], expected_ref: &str) -> DestinationReceipt {
    if report.len() > LIMIT {
        return DestinationReceipt::Unconfirmed;
    }
    let Some((b"unpack ok\n", after_unpack)) = packet(report) else {
        return DestinationReceipt::Unconfirmed;
    };
    let Some((status, end)) = packet(after_unpack) else {
        return DestinationReceipt::Unconfirmed;
    };
    if end != FLUSH {
        return DestinationReceipt::Unconfirmed;
    }
    if status
        .strip_prefix(b"ok ")
        .and_then(|line| line.strip_suffix(b"\n"))
        == Some(expected_ref.as_bytes())
    {
        return DestinationReceipt::Accepted;
    }
    if let Some(denial) = status
        .strip_prefix(b"ng ")
        .and_then(|line| line.strip_suffix(b"\n"))
    {
        let mut fields = denial.splitn(2, |byte| *byte == b' ');
        if fields.next() == Some(expected_ref.as_bytes())
            && fields.next().is_some_and(|message| {
                !message.is_empty() && !message.iter().any(u8::is_ascii_control)
            })
        {
            return DestinationReceipt::Rejected;
        }
    }
    DestinationReceipt::Unconfirmed
}

/// Project a complete outer sideband section to its bounded inner status.
/// A fatal channel or any extra bytes after the outer flush leave it unknown.
pub(super) fn read_sideband_report(mut wire: &[u8], expected_ref: &str) -> DestinationReceipt {
    if wire.len() > SIDEBAND_LIMIT {
        return DestinationReceipt::Unconfirmed;
    }
    let mut inner = Vec::new();
    while wire != FLUSH {
        let Some((payload, rest)) = packet(wire) else {
            return DestinationReceipt::Unconfirmed;
        };
        if payload.len() + 4 > SIDEBAND_PACKET_LIMIT {
            return DestinationReceipt::Unconfirmed;
        }
        match payload {
            [1, body @ ..] if !body.is_empty() && inner.len() + body.len() <= LIMIT => {
                inner.extend(body);
            }
            [2, body @ ..] if !body.is_empty() => {}
            _ => return DestinationReceipt::Unconfirmed,
        }
        wire = rest;
    }
    read_receive_report(&inner, expected_ref)
}

fn packet(report: &[u8]) -> Option<(&[u8], &[u8])> {
    let size = packet_length(*report.first_chunk::<4>()?)?;
    if size < 5 {
        return None;
    }
    let (parts, rest) = report.split_at_checked(size)?;
    Some((parts.get(4..)?, rest))
}

/// Summarize only receipts from the already ordered, all-destination approval.
/// A missing position stays unknown; an observed successful write followed by
/// any incomplete result takes precedence as partial. Never replay either state.
#[must_use]
pub fn summarize_push_receipts(
    approved_destination_count: usize,
    ordered: &[DestinationReceipt],
) -> PushReceipt {
    let written = ordered.contains(&DestinationReceipt::Accepted);
    let incomplete = approved_destination_count == 0
        || ordered.len() != approved_destination_count
        || ordered.contains(&DestinationReceipt::Unconfirmed);
    let rejected = ordered.contains(&DestinationReceipt::Rejected);
    if written && (incomplete || rejected) {
        PushReceipt::Partial
    } else if incomplete {
        PushReceipt::Unconfirmed
    } else if rejected {
        PushReceipt::Rejected
    } else if written {
        PushReceipt::AllAccepted
    } else {
        PushReceipt::UpToDate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(lines: &[&str]) -> Vec<u8> {
        let mut output = Vec::new();
        for line in lines {
            output.extend(format!("{:04x}", line.len() + 4).as_bytes());
            output.extend(line.as_bytes());
        }
        output.extend(FLUSH);
        output
    }

    #[test]
    fn accepts_or_rejects_only_the_bound_ref_and_complete_report() {
        let reference = "refs/heads/main";
        assert_eq!(
            read_receive_report(&report(&["unpack ok\n", "ok refs/heads/main\n"]), reference),
            DestinationReceipt::Accepted
        );
        assert_eq!(
            read_receive_report(
                &report(&["unpack ok\n", "ng refs/heads/main hook declined\n"]),
                reference
            ),
            DestinationReceipt::Rejected
        );
        for lines in [
            vec!["unpack ok\n", "ok refs/heads/elsewhere\n"],
            vec!["unpack incomplete\n", "ok refs/heads/main\n"],
            vec!["unpack ok\n", "ng refs/heads/main\n"],
            vec![
                "unpack ok\n",
                "ok refs/heads/main\n",
                "option refname refs/heads/elsewhere\n",
            ],
            vec!["unpack ok\n"],
        ] {
            assert_eq!(
                read_receive_report(&report(&lines), reference),
                DestinationReceipt::Unconfirmed
            );
        }
    }

    #[test]
    fn partial_effect_survives_rejection_missing_rows_and_lost_replies() {
        use DestinationReceipt::{Accepted, Rejected, Unchanged, Unconfirmed};
        assert_eq!(
            summarize_push_receipts(2, &[Accepted, Unchanged]),
            PushReceipt::AllAccepted
        );
        assert_eq!(
            summarize_push_receipts(2, &[Unchanged, Unchanged]),
            PushReceipt::UpToDate
        );
        assert_eq!(
            summarize_push_receipts(2, &[Accepted, Rejected]),
            PushReceipt::Partial
        );
        assert_eq!(
            summarize_push_receipts(2, &[Accepted, Unconfirmed]),
            PushReceipt::Partial
        );
        assert_eq!(
            summarize_push_receipts(2, &[Accepted]),
            PushReceipt::Partial
        );
        assert_eq!(
            summarize_push_receipts(2, &[Unchanged, Rejected]),
            PushReceipt::Rejected
        );
        assert_eq!(
            summarize_push_receipts(2, &[Rejected, Unconfirmed]),
            PushReceipt::Unconfirmed
        );
    }
}
