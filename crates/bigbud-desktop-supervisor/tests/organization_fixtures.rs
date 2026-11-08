use bigbud_desktop_supervisor::organization::{
    Admission, CompactState,
    protocol::{facts::v1::ThreadFacts, v1::Frame},
};
use prost::Message;

const GOLDEN: &str = include_str!("../../../protocol/thread-organization/snapshot-fixture.hex");

#[test]
fn ts_golden_matches_prost_and_activates_only_after_snapshot_end() {
    let mut state = CompactState::new("backend".into(), 7);
    let expected = [
        Admission::Negotiated,
        Admission::Staged,
        Admission::Staged,
        Admission::Staged,
        Admission::Activated,
        Admission::Applied,
        Admission::Applied,
        Admission::Duplicate,
    ];
    for (index, line) in GOLDEN.lines().enumerate() {
        let bytes: Vec<u8> = line
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("golden hex UTF-8");
                u8::from_str_radix(text, 16).expect("golden hex byte")
            })
            .collect();
        let frame = Frame::decode(bytes.as_slice()).expect("TS golden must decode with prost");
        assert_eq!(frame.encode_to_vec(), bytes, "canonical protobuf {index}");
        assert_eq!(state.admit(&bytes), Ok(expected[index]));
        if index < 4 {
            assert!(state.rows().is_none());
        }
        if index == 4 {
            let row: &ThreadFacts = state.rows().expect("active").next().expect("row");
            assert_eq!(row.fact_version, 2);
            assert_eq!(row.inactivity_at_ms, Some(0));
            assert!(row.actionable);
            assert_eq!(row.work, 2);
            assert_eq!(row.snooze_until_ms, Some(600_000));
        }
    }
    assert_eq!(state.frontier(), Some((13, 103, 2)));
    assert_eq!(state.rows().expect("active").count(), 0);
}

fn from_hex(line: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    line.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?))
        .collect()
}

#[test]
fn reduced_negotiated_limits_accept_ts_pages_and_fence_overflow() {
    let fixture = include_str!("../../../protocol/thread-organization/reduced-limits-fixture.hex");
    let frames: Vec<_> = fixture
        .lines()
        .map(|line| from_hex(line).expect("fixture hex"))
        .collect();
    let mut state = CompactState::new("backend".into(), 7);
    for bytes in &frames {
        assert!(state.admit(bytes).is_ok());
        assert!(bytes.len() <= 128);
    }
    assert_eq!(state.rows().expect("activated").count(), 2);
    // A valid default-limit stream cannot override the negotiated one-row cap.
    let mut state = CompactState::new("backend".into(), 7);
    assert!(state.admit(&frames[0]).is_ok());
    assert!(state.admit(&frames[1]).is_ok());
    let mut page = Frame::decode(frames[2].as_slice()).expect("page");
    if let Some(bigbud_desktop_supervisor::organization::protocol::v1::frame::Payload::Page(p)) =
        &mut page.payload
    {
        p.rows.push(p.rows[0].clone());
    } else {
        panic!("page");
    }
    assert!(state.admit(&page.encode_to_vec()).is_err());
    assert!(state.rows().is_none());
}

#[test]
fn shared_nested_singular_duplicates_are_rejected_before_normalization() {
    for line in
        include_str!("../../../protocol/thread-organization/malformed-duplicates.hex").lines()
    {
        let mut state = CompactState::new("backend".into(), 7);
        assert!(state.admit(&from_hex(line).expect("fixture hex")).is_err());
    }
}
