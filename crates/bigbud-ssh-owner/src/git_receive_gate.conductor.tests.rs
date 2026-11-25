use super::*;
use std::{cell::Cell, io::Cursor};

const OLD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REF: &str = "refs/heads/main";
const CAPS: &str = "report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta push-options object-format=sha1 agent=git/test";

fn approval() -> ApprovedTrackedUpdate<'static> {
    ApprovedTrackedUpdate {
        destination_ref: REF,
        advertised_old_oid: OLD,
        approved_source_oid: NEW,
    }
}

fn advertisement(caps: &str) -> Vec<u8> {
    section(&[format!("{OLD} {REF}\0{caps}\n").as_bytes()])
}

fn command(old: &str, new: &str, reference: &str, caps: &str) -> Vec<u8> {
    section(&[format!("{old} {new} {reference}\0 {caps}").as_bytes()])
}

fn exact_command(caps: &str) -> Vec<u8> {
    command(OLD, NEW, REF, caps)
}

fn section(packets: &[&[u8]]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for payload in packets {
        bytes.extend(format!("{:04x}", payload.len() + 4).as_bytes());
        bytes.extend(*payload);
    }
    bytes.extend(FLUSH);
    bytes
}

#[test]
fn binds_remote_old_oid_filters_capabilities_and_forwards_only_the_validated_prefix() {
    let report = section(&[b"unpack ok\n", b"ok refs/heads/main\n"]);
    let input = [advertisement(CAPS), report].concat();
    let mut remote_input = Vec::new();
    let bound = BoundTrackedReceive::bind(input.as_slice(), &mut remote_input, approval())
        .expect("the one bound ref was advertised");
    let expected = section(&[format!(
        "{OLD} {REF}\0report-status side-band-64k ofs-delta object-format=sha1"
    )
    .as_bytes()]);
    assert_eq!(bound.advertisement(), expected);

    let prefix = exact_command("report-status object-format=sha1");
    let pack = b"PACK fixture bytes remain unread until admission";
    let input = [prefix.as_slice(), pack].concat();
    let mut input = input.as_slice();
    let revalidated = Cell::new(false);
    let mut forwarded = bound
        .forward_prefix(&mut input, || {
            revalidated.set(true);
            true
        })
        .expect("the exact command with current lease is admitted");
    assert!(revalidated.get());
    assert_eq!(forwarded.pack_sink().as_slice(), prefix);
    assert_eq!(input, pack);
    io::copy(&mut input, forwarded.pack_sink()).unwrap();
    assert_eq!(forwarded.receive_report(), DestinationReceipt::Accepted);
    assert_eq!(remote_input, [prefix.as_slice(), pack].concat());
}

#[test]
fn missing_wrong_or_extra_advertised_refs_never_offer_a_write_channel() {
    let zero = "0".repeat(40);
    for advertisement in [
        section(&[]),
        section(&[format!("{zero} capabilities^{{}}\0{CAPS}").as_bytes()]),
        section(&[format!("{NEW} {REF}\0{CAPS}").as_bytes()]),
        section(&[format!("{OLD} refs/heads/other\0{CAPS}").as_bytes()]),
        section(&[format!("{OLD} {REF}\0{CAPS}").as_bytes(), b"another ref"]),
        advertisement("report-status-v2 object-format=sha1"),
        advertisement("report-status object-format=sha256"),
        advertisement("report-status report-status"),
        b"ffff".to_vec(),
    ] {
        let mut remote_input = Vec::new();
        assert!(matches!(
            BoundTrackedReceive::bind(advertisement.as_slice(), &mut remote_input, approval()),
            Err(TrackedReceiveError::InvalidAdvertisement)
        ));
        assert!(remote_input.is_empty());
    }
}

#[test]
fn an_already_matching_ref_does_not_enter_the_write_path() {
    let matching = ApprovedTrackedUpdate {
        approved_source_oid: OLD,
        ..approval()
    };
    let mut remote_input = Vec::new();
    assert!(matches!(
        BoundTrackedReceive::bind(io::empty(), &mut remote_input, matching),
        Err(TrackedReceiveError::Gate(ReceiveGateError::InvalidApproval))
    ));
    assert!(remote_input.is_empty());
}

#[test]
fn out_of_scope_or_stale_commands_forward_no_bytes() {
    use ReceiveGateError::{ExtraCommand, RefusedUpdate, UnsupportedCapabilities};
    use TrackedReceiveError::{Gate, StaleLease};
    let mut extra = exact_command("report-status");
    extra.truncate(extra.len() - FLUSH.len());
    extra.extend(section(&[b"second command"]));
    let cases = [
        (command(NEW, NEW, REF, "report-status"), Gate(RefusedUpdate)),
        (command(OLD, OLD, REF, "report-status"), Gate(RefusedUpdate)),
        (
            command(OLD, NEW, "refs/heads/other", "report-status"),
            Gate(RefusedUpdate),
        ),
        (
            exact_command("report-status-v2"),
            Gate(UnsupportedCapabilities),
        ),
        (extra, Gate(ExtraCommand)),
        (exact_command("report-status"), StaleLease),
    ];
    for (wire, expected) in cases {
        let mut remote_input = Vec::new();
        let advertisement = advertisement(CAPS);
        let bound =
            BoundTrackedReceive::bind(advertisement.as_slice(), &mut remote_input, approval())
                .unwrap();
        let invoked = Cell::new(false);
        let result = bound.forward_prefix(&mut wire.as_slice(), || {
            invoked.set(true);
            false
        });
        assert!(matches!(result, Err(error) if error == expected));
        assert_eq!(invoked.get(), expected == StaleLease);
        assert!(remote_input.is_empty());
    }
}

#[test]
fn partial_forward_is_unknown_and_never_touches_pack() {
    struct BreakAfterPrefixFragment(Vec<u8>);
    impl Write for BreakAfterPrefixFragment {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if !self.0.is_empty() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            self.0.extend(&bytes[..4]);
            Ok(4)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let advertisement = advertisement(CAPS);
    let mut remote_input = BreakAfterPrefixFragment(Vec::new());
    let bound =
        BoundTrackedReceive::bind(advertisement.as_slice(), &mut remote_input, approval()).unwrap();
    let prefix = exact_command("report-status");
    let input = [prefix.as_slice(), b"PACK"].concat();
    let mut input = input.as_slice();
    assert!(matches!(
        bound.forward_prefix(&mut input, || true),
        Err(TrackedReceiveError::UnconfirmedForward(
            io::ErrorKind::BrokenPipe
        ))
    ));
    assert_eq!(input, b"PACK");
    assert_eq!(remote_input.0, &prefix[..4]);
}

#[test]
fn transport_timeout_is_unknown_even_after_a_success_packet() {
    struct TimesOut;
    impl Read for TimesOut {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::TimedOut.into())
        }
    }
    let raw = [
        advertisement(CAPS),
        section(&[b"unpack ok\n", b"ok refs/heads/main\n"]),
    ]
    .concat();
    let bound =
        BoundTrackedReceive::bind(raw.as_slice().chain(TimesOut), io::sink(), approval()).unwrap();
    let forwarded = bound
        .forward_prefix(&mut exact_command("report-status").as_slice(), || true)
        .unwrap();
    assert_eq!(forwarded.receive_report(), DestinationReceipt::Unconfirmed);
}

#[test]
fn classifies_only_complete_bounded_reports_from_the_admitted_channel() {
    use DestinationReceipt::{Accepted, Rejected, Unconfirmed};
    let inner = section(&[b"unpack ok\n", b"ok refs/heads/main\n"]);
    let a = [&[1], &inner[..6]].concat();
    let b = [&[1], &inner[6..]].concat();
    let good = section(&[&a, b"\x02progress\n", &b]);
    let rejected = section(&[b"unpack ok\n", b"ng refs/heads/main fixture rejected\n"]);
    let cases = [
        ("report-status side-band-64k", good.clone(), Accepted),
        ("report-status", rejected, Rejected),
        ("report-status", good.clone(), Unconfirmed),
        ("report-status side-band-64k", Vec::new(), Unconfirmed),
        (
            "report-status side-band-64k",
            good[..good.len() - 4].to_vec(),
            Unconfirmed,
        ),
        (
            "report-status side-band-64k",
            [good.as_slice(), FLUSH].concat(),
            Unconfirmed,
        ),
        (
            "report-status side-band-64k",
            section(&[&a, &b, b"\x03fatal"]),
            Unconfirmed,
        ),
        (
            "report-status side-band-64k",
            section(&[&a, &b, &[1; report::LIMIT + 1]]),
            Unconfirmed,
        ),
        (
            "report-status side-band-64k",
            vec![0; report::SIDEBAND_LIMIT + 1],
            Unconfirmed,
        ),
    ];
    for (caps, report, expected) in cases {
        let input = [advertisement(CAPS).as_slice(), &report].concat();
        let remote = Cursor::new(input);
        let bound = BoundTrackedReceive::bind(remote, io::sink(), approval()).unwrap();
        let forwarded = bound
            .forward_prefix(&mut exact_command(caps).as_slice(), || true)
            .unwrap();
        let (receipt, wire) = forwarded.exchange_pack(|mut remote, _sink, cap| {
            assert_eq!(
                cap,
                if caps.contains("side-band-64k") {
                    super::report::SIDEBAND_LIMIT
                } else {
                    super::report::LIMIT
                }
            );
            let mut wire = Vec::new();
            remote.read_to_end(&mut wire)?;
            Ok(wire)
        });
        assert_eq!(receipt, expected);
        assert_eq!(
            wire,
            if expected == Unconfirmed {
                Vec::new()
            } else {
                report
            }
        );
    }
}
