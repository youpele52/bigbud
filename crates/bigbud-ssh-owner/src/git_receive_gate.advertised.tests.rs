use super::super::super::{DestinationReceipt, ReceiveGateError};
use super::*;
use std::io;

const OLD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER: &str = "cccccccccccccccccccccccccccccccccccccccc";
const ZERO: &str = "0000000000000000000000000000000000000000";
const REF: &str = "refs/heads/main";
const CAPS: &str = "report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=git/2.47.3";
const NARROWED: &str = "report-status side-band-64k ofs-delta object-format=sha1";

fn approval(old: &'static str, new: &'static str) -> ApprovedTrackedUpdate<'static> {
    ApprovedTrackedUpdate {
        destination_ref: REF,
        advertised_old_oid: old,
        approved_source_oid: new,
    }
}

fn section(packets: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for payload in packets {
        bytes.extend(format!("{:04x}", payload.len() + 4).as_bytes());
        bytes.extend(payload.as_bytes());
    }
    bytes.extend(FLUSH);
    bytes
}

/// A realistic multi-ref advertisement with the destination in the middle.
fn live(main: &str) -> Vec<u8> {
    section(&[
        format!("{OTHER} refs/heads/dev\0{CAPS}\n"),
        format!("{main} {REF}\n"),
        format!("{OTHER} refs/tags/v1\n"),
        format!("{OTHER} .have\n"),
    ])
}

fn single(oid: &str) -> Vec<u8> {
    section(&[format!("{oid} {REF}\0{NARROWED}")])
}

#[test]
fn binds_the_destination_among_many_refs_and_narrows_capabilities() {
    let report = section(&["unpack ok\n".into(), format!("ok {REF}\n")]);
    let input = [live(OLD), report].concat();
    let mut remote_input = Vec::new();
    let Ok(AdvertisedReceive::Update(bound)) =
        bind_advertised(input.as_slice(), &mut remote_input, approval(OLD, NEW))
    else {
        panic!("the approved old OID was advertised");
    };
    assert_eq!(bound.advertisement(), single(OLD));
    let prefix = section(&[format!(
        "{OLD} {NEW} {REF}\0 report-status object-format=sha1"
    )]);
    let pack = b"PACK bytes";
    let client = [prefix.as_slice(), pack].concat();
    let mut client = client.as_slice();
    let mut forwarded = bound.forward_prefix(&mut client, || true).unwrap();
    io::copy(&mut client, forwarded.pack_sink()).unwrap();
    assert_eq!(forwarded.receive_report(), DestinationReceipt::Accepted);
    assert_eq!(remote_input, [prefix.as_slice(), pack].concat());
}

#[test]
fn a_moved_or_absent_destination_is_stale() {
    let mut sink = Vec::new();
    for advertisement in [
        live(OTHER),
        section(&[format!("{OTHER} refs/heads/dev\0{CAPS}\n")]),
        section(&[format!("{ZERO} capabilities^{{}}\0{CAPS}\n")]),
    ] {
        assert!(matches!(
            bind_advertised(advertisement.as_slice(), &mut sink, approval(OLD, NEW)),
            Err(TrackedReceiveError::StaleRef)
        ));
    }
    assert!(sink.is_empty());
}

#[test]
fn an_equal_approval_observes_without_a_writer() {
    let mut sink = Vec::new();
    let Ok(AdvertisedReceive::Unchanged(advertisement)) =
        bind_advertised(live(OLD).as_slice(), &mut sink, approval(OLD, OLD))
    else {
        panic!("matching live ref is unchanged");
    };
    assert_eq!(advertisement, single(OLD));
    assert!(sink.is_empty());
}

#[test]
fn a_command_for_another_ref_or_oid_is_refused_after_binding() {
    for (old, new, reference) in [
        (OLD, NEW, "refs/heads/dev"),
        (OTHER, NEW, REF),
        (OLD, OTHER, REF),
    ] {
        let mut sink = Vec::new();
        let advertisement = live(OLD);
        let Ok(AdvertisedReceive::Update(bound)) =
            bind_advertised(advertisement.as_slice(), &mut sink, approval(OLD, NEW))
        else {
            panic!("bound");
        };
        let command = section(&[format!("{old} {new} {reference}\0 report-status")]);
        assert_eq!(
            bound.forward_prefix(&mut command.as_slice(), || true).err(),
            Some(TrackedReceiveError::Gate(ReceiveGateError::RefusedUpdate))
        );
        assert!(sink.is_empty());
    }
}

#[test]
fn malformed_advertisements_fail_closed() {
    let duplicate = section(&[format!("{OLD} {REF}\0{CAPS}\n"), format!("{OLD} {REF}\n")]);
    let late_placeholder = section(&[
        format!("{OLD} {REF}\0{CAPS}\n"),
        format!("{ZERO} capabilities^{{}}\n"),
    ]);
    let wrong_width = section(&[format!("{OLD}aaaaaaaaaaaaaaaaaaaaaaaa {REF}\0{CAPS}\n")]);
    let no_report = section(&[format!("{OLD} {REF}\0side-band-64k\n")]);
    let second_caps = section(&[
        format!("{OLD} {REF}\0{CAPS}\n"),
        format!("{OTHER} refs/heads/x\0{CAPS}\n"),
    ]);
    let truncated = live(OLD)[..20].to_vec();
    for advertisement in [
        duplicate,
        late_placeholder,
        wrong_width,
        no_report,
        second_caps,
        FLUSH.to_vec(),
        b"fff1".to_vec(),
    ] {
        assert!(matches!(
            bind_advertised(advertisement.as_slice(), Vec::new(), approval(OLD, NEW)),
            Err(TrackedReceiveError::InvalidAdvertisement)
        ));
    }
    assert!(matches!(
        bind_advertised(truncated.as_slice(), Vec::new(), approval(OLD, NEW)),
        Err(TrackedReceiveError::AdvertisementIo(_))
    ));
}

#[test]
fn invalid_approvals_are_refused_before_reading() {
    let unread = live(OLD);
    let mut reader = unread.as_slice();
    assert!(matches!(
        bind_advertised(&mut reader, Vec::new(), approval(OLD, ZERO)),
        Err(TrackedReceiveError::Gate(ReceiveGateError::InvalidApproval))
    ));
    assert_eq!(reader.len(), unread.len());
}

#[test]
fn a_first_publish_needs_an_absent_ref_and_admits_only_the_zero_old_command() {
    // Absent destination: the client sees no ref, the live tips as `.have`.
    let advertisement = section(&[
        format!("{OTHER} refs/heads/dev\0{CAPS}\n"),
        format!("{OTHER} refs/tags/v1\n"),
    ]);
    let report = section(&["unpack ok\n".into(), format!("ok {REF}\n")]);
    let input = [advertisement, report].concat();
    let mut remote_input = Vec::new();
    let Ok(AdvertisedReceive::Update(bound)) =
        bind_advertised(input.as_slice(), &mut remote_input, approval(ZERO, NEW))
    else {
        panic!("an absent ref admits a first publish");
    };
    // As receive-pack writes it: capabilities on the first `.have` line.
    let expected = section(&[format!("{OTHER} .have\0{NARROWED}\n")]);
    assert_eq!(bound.advertisement(), expected);
    let prefix = section(&[format!("{ZERO} {NEW} {REF}\0 report-status")]);
    let client = [prefix.as_slice(), b"PACK"].concat();
    let mut client = client.as_slice();
    let mut forwarded = bound.forward_prefix(&mut client, || true).unwrap();
    io::copy(&mut client, forwarded.pack_sink()).unwrap();
    assert_eq!(forwarded.receive_report(), DestinationReceipt::Accepted);

    // A present destination is stale; a nonzero old command is refused.
    let mut sink = Vec::new();
    assert!(matches!(
        bind_advertised(live(OLD).as_slice(), &mut sink, approval(ZERO, NEW)),
        Err(TrackedReceiveError::StaleRef)
    ));
    let absent = section(&[format!("{ZERO} capabilities^{{}}\0{CAPS}\n")]);
    let Ok(AdvertisedReceive::Update(bound)) =
        bind_advertised(absent.as_slice(), &mut sink, approval(ZERO, NEW))
    else {
        panic!("bound");
    };
    // An empty repository: only the placeholder carries the capabilities.
    let empty = section(&[format!("{ZERO} capabilities^{{}}\0{NARROWED}\n")]);
    assert_eq!(bound.advertisement(), empty);
    let command = section(&[format!("{OLD} {NEW} {REF}\0 report-status")]);
    assert_eq!(
        bound.forward_prefix(&mut command.as_slice(), || true).err(),
        Some(TrackedReceiveError::Gate(ReceiveGateError::RefusedUpdate))
    );
    assert!(sink.is_empty());
}
