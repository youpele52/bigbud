//! Model API: queries and replies, snapshot caps and trimming, checkpoints, memory estimate.

use super::super::{
    CheckpointError, DetectedQuery, ExclusionKind, Fidelity, ModeState, ReplyContext, ScreenError,
    ScreenModel, SnapshotError, SnapshotLimits, query_reply,
};
use super::corpus::restore_from_snapshot;
use super::dump::{diff, dump};

fn model(cols: u16, rows: u16) -> ScreenModel {
    ScreenModel::new(cols, rows, 1_000).expect("model")
}

#[test]
fn detects_the_bounded_query_set_with_state_captured_in_order() {
    let mut screen = model(20, 5);
    let output = screen.feed(
        concat!(
            "\x1b[c\x1b[0c\x1b[>c\x1b[5n\x1b[3;7H\x1b[6n\x1b[1;1H",
            "\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]10;?;?\x07\x1b]52;c;?\x07\x1b[21t",
            "\x1b[?1$p\x1b[4$p\x1b[?2004h\x1b[?2004$p\x1b[?2026$p\x1b[?9999$p",
        )
        .as_bytes(),
    );
    let mode = |private, mode, state| DetectedQuery::ModeStatus {
        private,
        mode,
        state,
    };
    assert_eq!(
        output.queries,
        [
            DetectedQuery::PrimaryDeviceAttributes,
            DetectedQuery::PrimaryDeviceAttributes,
            DetectedQuery::DeviceStatus,
            DetectedQuery::CursorPosition { row: 3, col: 7 },
            DetectedQuery::ForegroundColor,
            DetectedQuery::BackgroundColor,
            DetectedQuery::ForegroundColor,
            DetectedQuery::BackgroundColor,
            mode(true, 1, ModeState::Reset),
            mode(false, 4, ModeState::Reset),
            mode(true, 2004, ModeState::Set),
            mode(true, 2026, ModeState::Reset),
        ]
    );
}

#[test]
fn a_query_split_across_feeds_is_reported_once() {
    let mut screen = model(10, 3);
    assert!(screen.feed(b"ab\x1b[").queries.is_empty());
    assert_eq!(
        screen.feed(b"6n").queries,
        [DetectedQuery::CursorPosition { row: 1, col: 3 }]
    );
}

#[test]
fn replies_match_xterm_js() {
    let context = ReplyContext {
        foreground: Some([0xff, 0x80, 0x00]),
        background: None,
    };
    let reply =
        |query| query_reply(&query, &context).map(|bytes| String::from_utf8(bytes).expect("utf8"));
    assert_eq!(
        reply(DetectedQuery::PrimaryDeviceAttributes).as_deref(),
        Some("\x1b[?1;2c")
    );
    assert_eq!(
        reply(DetectedQuery::DeviceStatus).as_deref(),
        Some("\x1b[0n")
    );
    assert_eq!(
        reply(DetectedQuery::CursorPosition { row: 4, col: 9 }).as_deref(),
        Some("\x1b[4;9R")
    );
    assert_eq!(
        reply(DetectedQuery::ForegroundColor).as_deref(),
        Some("\x1b]10;rgb:ffff/8080/0000\x1b\\")
    );
    assert_eq!(
        reply(DetectedQuery::BackgroundColor),
        None,
        "no theme colour, no reply"
    );
    let status = DetectedQuery::ModeStatus {
        private: true,
        mode: 2004,
        state: ModeState::Set,
    };
    assert_eq!(reply(status).as_deref(), Some("\x1b[?2004;1$y"));
    let ansi = DetectedQuery::ModeStatus {
        private: false,
        mode: 4,
        state: ModeState::Reset,
    };
    assert_eq!(reply(ansi).as_deref(), Some("\x1b[4;2$y"));
}

fn fill(screen: &mut ScreenModel, lines: usize) {
    for line in 0..lines {
        let colour = line % 200 + 16;
        let text = format!("\x1b[38;5;{colour}m{line:06} {}\x1b[m\r\n", "x".repeat(150));
        let _ = screen.feed(text.as_bytes());
    }
}

#[test]
fn caps_trim_oldest_scrollback_and_never_the_screen() {
    let mut screen = model(200, 50);
    fill(&mut screen, 1_100);
    let limits = SnapshotLimits {
        max_utf16_units: 120_000,
        max_utf8_bytes: 100_000,
        max_scrollback_rows: usize::MAX,
    };
    let snapshot = screen.snapshot(&limits).expect("snapshot");
    assert!(snapshot.ansi.len() <= limits.max_utf8_bytes);
    assert!(snapshot.utf16_units <= limits.max_utf16_units);
    assert_eq!(snapshot.utf16_units, snapshot.ansi.encode_utf16().count());
    assert_eq!(snapshot.fidelity.fidelity, Fidelity::Trimmed);
    assert_eq!(
        snapshot.fidelity.trimmed_rows + snapshot.scrollback_rows,
        1_000
    );
    let mut restored = model(200, 50);
    let _ = restored.feed(snapshot.ansi.as_bytes());
    let (ours, theirs) = (dump(&screen), dump(&restored));
    assert_eq!(
        ours.visible, theirs.visible,
        "visible rows are never trimmed"
    );
    let kept = theirs.scrollback.len();
    assert_eq!(
        ours.scrollback.get(ours.scrollback.len() - kept..),
        Some(theirs.scrollback.as_slice())
    );
}

#[test]
fn default_caps_hold_for_a_full_200x50_model() {
    let mut screen = model(200, 50);
    fill(&mut screen, 1_200);
    let snapshot = screen
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    assert!(snapshot.ansi.len() <= 3 * 1024 * 1024);
    assert!(snapshot.utf16_units <= 1_048_576);
    let restored = restore_from_snapshot(&screen);
    let trimmed = snapshot.fidelity.trimmed_rows;
    if trimmed == 0 {
        assert!(diff(&dump(&screen), &dump(&restored)).is_empty());
    }
}

#[test]
fn request_limits_cap_scrollback_and_visible_overflow_is_an_error() {
    let mut screen = model(80, 10);
    fill(&mut screen, 100);
    let limits = SnapshotLimits::from_request(0, 0, 25);
    let snapshot = screen.snapshot(&limits).expect("snapshot");
    assert_eq!(snapshot.scrollback_rows, 25);
    assert_eq!(
        snapshot.fidelity.trimmed_rows, 0,
        "request limits are not cap trimming"
    );
    let tiny = SnapshotLimits {
        max_utf8_bytes: 100,
        ..SnapshotLimits::default()
    };
    assert!(matches!(
        screen.snapshot(&tiny),
        Err(SnapshotError::VisibleExceedsLimits { .. })
    ));
}

#[test]
fn checkpoint_restores_an_equivalent_model_and_rejects_damage() {
    let mut screen = model(30, 4);
    let _ =
        screen.feed(b"\x1b]8;;https://x\x07link\x1b]8;;\x07\r\n\x1b[31mred\x1b[?1004h\x1b(0q\x1b[");
    let blob = screen.checkpoint().expect("checkpoint");
    let restored = ScreenModel::restore(&blob).expect("restore");
    assert!(diff(&dump(&screen), &dump(&restored)).is_empty());
    assert_eq!(restored.scanner.pending_tail().as_ref(), b"\x1b[");
    let snapshot = restored
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    let kinds: Vec<_> = snapshot
        .fidelity
        .exclusions
        .iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        [ExclusionKind::Osc8LinkTargets],
        "marks survive the checkpoint"
    );
    let mut damaged = blob.clone();
    if let Some(byte) = damaged.get_mut(20) {
        *byte ^= 1;
    }
    assert_eq!(
        ScreenModel::restore(&damaged).err(),
        Some(CheckpointError::Digest)
    );
    assert!(matches!(
        ScreenModel::restore(&blob[..10]),
        Err(CheckpointError::Digest | CheckpointError::Malformed(_))
    ));
}

#[test]
fn geometry_and_scrollback_are_validated() {
    assert_eq!(
        ScreenModel::new(0, 5, 10).err(),
        Some(ScreenError::InvalidGeometry { cols: 0, rows: 5 })
    );
    assert_eq!(
        ScreenModel::new(5, 5, 10_001).err(),
        Some(ScreenError::ScrollbackTooLarge(10_001))
    );
    let mut screen = model(5, 5);
    assert!(screen.resize(5, 0).is_err());
    assert_eq!(screen.geometry().rows, 5);
}

#[test]
fn estimated_bytes_tracks_allocated_rows() {
    let mut screen = model(200, 50);
    let empty = screen.estimated_bytes();
    fill(&mut screen, 1_100);
    let full = screen.estimated_bytes();
    assert!(full > empty);
    // 1,050 rows x (200 x 32 B + 40 B): vt100's 32-byte cells put a full 200x50 model with
    // 1,000 scrollback rows at ~6.8 MB, above the plan's 6 MiB budget (reported as open).
    assert_eq!(full / 100_000, 1_050 * (200 * 32 + 40) / 100_000);
    let _ = screen.feed(b"\x1b[?1049h");
    assert!(
        screen.estimated_bytes() >= full + 50 * 200 * 32,
        "alternate rows counted"
    );
}
