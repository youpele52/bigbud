use super::*;
use std::io::Cursor;

const OLD: &str = "1111111111111111111111111111111111111111";
const NEW: &str = "2222222222222222222222222222222222222222";
const MAIN: &str = "refs/heads/main";

fn approval() -> ApprovedTrackedUpdate<'static> {
    ApprovedTrackedUpdate {
        destination_ref: MAIN,
        advertised_old_oid: OLD,
        approved_source_oid: NEW,
    }
}

fn packet(payload: &str) -> Vec<u8> {
    let mut wire = format!("{:04x}", payload.len() + 4).into_bytes();
    wire.extend(payload.as_bytes());
    wire
}

fn approved_wire(caps: &str) -> Vec<u8> {
    let mut wire = packet(&format!("{OLD} {NEW} {MAIN}\0{caps}"));
    wire.extend(FLUSH);
    wire
}

#[test]
fn admits_the_exact_prefix_without_consuming_pack_bytes() {
    let prefix = approved_wire(" report-status-v2 side-band-64k object-format=sha1");
    let mut all = prefix.clone();
    let pack = b"PACK synthetic data left unread";
    all.extend(pack);
    let mut reader = Cursor::new(all);
    assert_eq!(
        authorize_receive_prefix(&mut reader, approval()),
        Ok(prefix)
    );
    let mut remaining = Vec::new();
    reader
        .read_to_end(&mut remaining)
        .expect("read unmodified bytes");
    assert_eq!(remaining, pack);
}

#[test]
fn refuses_stale_old_oid_wrong_source_wrong_ref_and_delete() {
    for (old, new, name) in [
        (NEW, NEW, MAIN),
        (OLD, OLD, MAIN),
        (OLD, NEW, "refs/heads/sibling"),
        (OLD, "0000000000000000000000000000000000000000", MAIN),
    ] {
        let mut wire = packet(&format!("{old} {new} {name}\0report-status"));
        wire.extend(FLUSH);
        assert_eq!(
            authorize_receive_prefix(&mut wire.as_slice(), approval()),
            Err(ReceiveGateError::RefusedUpdate)
        );
    }
}

#[test]
fn refuses_second_command_without_reading_its_body_or_pack() {
    let mut prefix = packet(&format!("{OLD} {NEW} {MAIN}\0report-status"));
    let other = packet(&format!("{OLD} {NEW} refs/heads/sibling"));
    let before = prefix.len();
    prefix.extend(other);
    let mut reader = Cursor::new(prefix);
    assert_eq!(
        authorize_receive_prefix(&mut reader, approval()),
        Err(ReceiveGateError::ExtraCommand)
    );
    assert_eq!(reader.position(), (before + 4) as u64);
}

#[test]
fn refuses_hooks_options_wrong_hash_format_and_unconfirmed_exits() {
    for caps in [
        "report-status push-options",
        "report-status object-format=sha256",
        "report-status report-status",
        "report-status report-status-v2",
        "side-band-64k",
        "report-status\0ignored",
        "report-status quiet",
    ] {
        let wire = approved_wire(caps);
        assert_eq!(
            authorize_receive_prefix(&mut wire.as_slice(), approval()),
            Err(ReceiveGateError::UnsupportedCapabilities)
        );
    }
}

#[test]
fn sha256_tracks_the_same_exact_object_format() {
    let old = "1".repeat(64);
    let new = "2".repeat(64);
    let mut wire = packet(&format!(
        "{old} {new} {MAIN}\0report-status object-format=sha256"
    ));
    wire.extend(FLUSH);
    assert_eq!(
        authorize_receive_prefix(
            &mut wire.as_slice(),
            ApprovedTrackedUpdate {
                destination_ref: MAIN,
                advertised_old_oid: &old,
                approved_source_oid: &new
            }
        ),
        Ok(wire)
    );
}

#[test]
fn refuses_invalid_boundaries_before_pack_admission() {
    assert_eq!(
        authorize_receive_prefix(&mut b"ffff".as_slice(), approval()),
        Err(ReceiveGateError::CommandTooLarge)
    );
    assert_eq!(
        authorize_receive_prefix(&mut b"0004".as_slice(), approval()),
        Err(ReceiveGateError::MalformedCommand)
    );
    assert_eq!(
        authorize_receive_prefix(&mut b"000aa".as_slice(), approval()),
        Err(ReceiveGateError::Io(io::ErrorKind::UnexpectedEof))
    );
    let mut bad = approval();
    bad.destination_ref = "refs/heads/../sibling";
    assert_eq!(
        authorize_receive_prefix(&mut b"".as_slice(), bad),
        Err(ReceiveGateError::InvalidApproval)
    );
}
