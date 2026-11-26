use std::mem::size_of;

use crate::pty_lifecycle::{
    SNAPSHOT_CHUNK_MAX_BYTES, SNAPSHOT_MAX_CHUNKS, SNAPSHOT_MAX_ESCAPE_TAIL_BYTES,
    SNAPSHOT_MAX_TOTAL_BYTES,
};
use crate::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};
use v1::frame::Payload;

#[path = "pty_lifecycle.fixtures.rs"]
mod fixtures;
use fixtures::{frame, small_frames};

const GOLDENS: &str = include_str!("../../../../protocol/remote-agent/v1.golden.frames");
/// Largest `through_sequence` the TypeScript codec accepts (2^53 - 1).
const MAX_SAFE_SEQUENCE: u64 = (1 << 53) - 1;

fn golden(name: &str) -> Vec<u8> {
    let (_, hex) = GOLDENS
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| *key == name)
        .unwrap_or_else(|| panic!("shared lifecycle golden {name} exists"));
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

/// Deterministic bulk bytes shared with the TypeScript goldens: byte `i` of a
/// transfer is `i % 251`, so maximum-size goldens store only framing bytes.
fn fill(start: usize, length: usize) -> Vec<u8> {
    (start..start + length).map(|i| (i % 251) as u8).collect()
}

/// A maximum-size golden is `<name>_head`, the fill, then `<name>_tail` (if any).
fn large_golden(name: &str, fill_start: usize, fill_length: usize) -> Vec<u8> {
    let mut bytes = golden(&format!("{name}_head"));
    bytes.extend(fill(fill_start, fill_length));
    if GOLDENS.contains(&format!("{name}_tail=")) {
        bytes.extend(golden(&format!("{name}_tail")));
    }
    bytes
}

fn assert_round_trip(bytes: &[u8], frame: &v1::Frame) {
    assert_eq!(
        &encode_frame(frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
        bytes
    );
    assert_eq!(
        &decode_frame(bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
        frame
    );
}

fn max_header() -> v1::Frame {
    frame(Payload::PtyScreenSnapshotHeader(Box::new(
        v1::PtyScreenSnapshotHeader {
            request_id: "r".repeat(64),
            pty_id: "p".repeat(64),
            accepted: true,
            error_code: String::new(),
            through_sequence: MAX_SAFE_SEQUENCE,
            cols: u32::MAX,
            rows: u32::MAX,
            scrollback_rows: u32::MAX,
            alternate_screen: true,
            fidelity: "trimmed".to_owned(),
            model_state: "invalid".to_owned(),
            chunk_count: SNAPSHOT_MAX_CHUNKS,
            total_ansi_bytes: SNAPSHOT_MAX_TOTAL_BYTES,
            pending_escape_tail: fill(0, SNAPSHOT_MAX_ESCAPE_TAIL_BYTES),
            sha256: vec![0xff; 32],
            trimmed_rows: u32::MAX,
            error_message: String::new(),
        },
    )))
}

fn max_chunk(index: u32, last: bool) -> v1::Frame {
    let start = index as usize * SNAPSHOT_CHUNK_MAX_BYTES;
    frame(Payload::PtyScreenSnapshotChunk(
        v1::PtyScreenSnapshotChunk {
            request_id: "r".repeat(64),
            index,
            last,
            bytes: fill(start, SNAPSHOT_CHUNK_MAX_BYTES),
        },
    ))
}

#[test]
fn lifecycle_frames_match_shared_typescript_goldens() {
    for (name, frame) in small_frames() {
        assert_round_trip(&golden(name), &frame);
    }
}

#[test]
fn maximum_size_snapshot_frames_match_shared_goldens() {
    let header = large_golden(
        "pty_screen_snapshot_header_max",
        0,
        SNAPSHOT_MAX_ESCAPE_TAIL_BYTES,
    );
    assert_round_trip(&header, &max_header());

    let single = large_golden("pty_screen_snapshot_chunk_max", 0, SNAPSHOT_CHUNK_MAX_BYTES);
    assert_round_trip(&single, &max_chunk(0, true));

    let mut total = 0_u64;
    for index in 0..SNAPSHOT_MAX_CHUNKS {
        let start = index as usize * SNAPSHOT_CHUNK_MAX_BYTES;
        let name = format!("pty_screen_snapshot_chunk_3mib_{index:02}");
        let bytes = large_golden(&name, start, SNAPSHOT_CHUNK_MAX_BYTES);
        assert_round_trip(&bytes, &max_chunk(index, index + 1 == SNAPSHOT_MAX_CHUNKS));
        // Paced response frames stay far below the 1 MiB frame limit.
        assert!(bytes.len() < DEFAULT_MAX_FRAME_BYTES / 4);
        total += SNAPSHOT_CHUNK_MAX_BYTES as u64;
    }
    assert_eq!(total, SNAPSHOT_MAX_TOTAL_BYTES);
}

#[test]
fn additive_fields_default_for_older_peers() {
    // A pre-1.9 create, create response and inventory entry decode with every
    // lifecycle field at its default, so older clients keep legacy behavior.
    let Some(Payload::PtyCreateRequest(create)) =
        decode_frame(&golden("pty_profile_true"), DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .payload
    else {
        panic!("expected PTY create");
    };
    assert!(!create.lifecycle_managed && !create.local_launch && !create.spool);
    assert!(create.evict_pty_id.is_empty() && create.screen_scrollback_rows == 0);
    let Some(Payload::PtyCreateResponse(response)) =
        decode_frame(&golden("pty_create_unconfirmed"), DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .payload
    else {
        panic!("expected PTY create response");
    };
    assert_eq!((response.limit, response.live_count), (0, 0));
    let Some(Payload::AgentHello(hello)) =
        decode_frame(&golden("agent_hello"), DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .payload
    else {
        panic!("expected agent hello");
    };
    assert_eq!((hello.process_id, hello.process_start_time_ms), (0, 0));
}

#[test]
fn lifecycle_payloads_do_not_grow_the_frame() {
    let largest_legacy = size_of::<v1::PtyCreateRequest>().max(size_of::<v1::AgentHello>());
    assert!(size_of::<v1::Frame>() <= largest_legacy + size_of::<usize>());
}
