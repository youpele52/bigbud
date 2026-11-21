//! Corpus-wide properties: xterm.js expectations, chunk-split invariance, zero-diff round
//! trips (including what happens to output after the snapshot), and honest fidelity.

use super::super::{ExclusionKind, Fidelity, ScreenModel, SnapshotLimits};
use super::dump::{diff, dump};
use super::fixtures::corpus;

/// The tracker state a round trip must preserve exactly.
fn tracked_state(model: &ScreenModel) -> String {
    let t = &model.tracker;
    format!(
        "alt={} regions={:?} origin={} autowrap={} insert={} reverse={} focus={} sync={} kitty={:?} \
         g0={:?} g1={:?} so={} link={:?} open={} unsupported={} tabs={:?}/{:?} reverse_video={}",
        t.alt_active,
        t.regions,
        t.origin,
        t.autowrap,
        t.insert,
        t.reverse_wrap,
        t.focus,
        t.sync_output,
        t.kitty,
        t.g0,
        t.g1,
        t.shifted_out,
        t.link,
        t.link_open,
        t.unsupported,
        t.custom_tab_stops(0),
        t.custom_tab_stops(1),
        t.reverse_video,
    )
}

pub(crate) fn restore_from_snapshot(model: &ScreenModel) -> ScreenModel {
    let snapshot = model
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    let geometry = model.geometry();
    let mut restored =
        ScreenModel::new(geometry.cols, geometry.rows, model.scrollback_capacity()).expect("model");
    let queries = restored.feed(snapshot.ansi.as_bytes());
    assert!(
        queries.queries.is_empty(),
        "snapshots never contain queries"
    );
    let _ = restored.feed(&snapshot.pending_escape_tail);
    restored
}

#[test]
fn every_fixture_meets_its_xterm_expectations() {
    let mut failures = Vec::new();
    for fixture in corpus() {
        let model = fixture.run();
        let mut out = Vec::new();
        (fixture.expect)(&dump(&model), &model, &mut out);
        failures.extend(
            out.into_iter()
                .map(|line| format!("{}: {line}", fixture.name)),
        );
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn bytewise_feeding_matches_whole_chunks() {
    for fixture in corpus() {
        let whole = fixture.run();
        let bytewise = fixture.run_bytewise();
        let differences = diff(&dump(&whole), &dump(&bytewise));
        assert!(differences.is_empty(), "{}: {differences:#?}", fixture.name);
        assert_eq!(
            tracked_state(&whole),
            tracked_state(&bytewise),
            "{}",
            fixture.name
        );
        let limits = SnapshotLimits::default();
        let (a, b) = (
            whole.snapshot(&limits).expect("a"),
            bytewise.snapshot(&limits).expect("b"),
        );
        assert_eq!(a.ansi, b.ansi, "{}", fixture.name);
        assert_eq!(
            a.pending_escape_tail, b.pending_escape_tail,
            "{}",
            fixture.name
        );
    }
}

#[test]
fn snapshots_round_trip_with_zero_diffs() {
    for fixture in corpus() {
        let mut original = fixture.run();
        let mut restored = restore_from_snapshot(&original);
        let differences = diff(&dump(&original), &dump(&restored));
        assert!(differences.is_empty(), "{}: {differences:#?}", fixture.name);
        assert_eq!(
            tracked_state(&original),
            tracked_state(&restored),
            "{}",
            fixture.name
        );
        // Live output after the cut must land identically (pending wrap, saved cursor,
        // modes, charsets, open links and attributes all carry over).
        for continuation in [
            "Zq",
            "\x1b8\x1b[1mQ\r\nnext\x1b[?1049l\x1b[4;1Hx",
            "\x1b\\tail",
        ] {
            let _ = original.feed(continuation.as_bytes());
            let _ = restored.feed(continuation.as_bytes());
            let differences = diff(&dump(&original), &dump(&restored));
            assert!(
                differences.is_empty(),
                "{} after {continuation:?}: {differences:#?}",
                fixture.name
            );
        }
    }
}

#[test]
fn second_round_trip_is_byte_identical() {
    for fixture in corpus() {
        let original = fixture.run();
        let restored = restore_from_snapshot(&original);
        let limits = SnapshotLimits::default();
        let first = original.snapshot(&limits).expect("first");
        let second = restored.snapshot(&limits).expect("second");
        assert_eq!(first.ansi, second.ansi, "{}", fixture.name);
    }
}

#[test]
fn fixtures_report_exactly_their_exclusions() {
    for fixture in corpus() {
        let model = fixture.run();
        let snapshot = model
            .snapshot(&SnapshotLimits::default())
            .expect("snapshot");
        let mut kinds: Vec<ExclusionKind> = snapshot
            .fidelity
            .exclusions
            .iter()
            .map(|exclusion| exclusion.kind)
            .collect();
        kinds.sort_by_key(|kind| kind.as_str());
        let mut expected = fixture.exclusions.to_vec();
        expected.sort_by_key(|kind| kind.as_str());
        assert_eq!(kinds, expected, "{}", fixture.name);
        let affects_rows = snapshot.fidelity.exclusions.iter().any(|e| e.rows > 0);
        let fidelity = if affects_rows {
            Fidelity::Trimmed
        } else {
            Fidelity::Full
        };
        assert_eq!(snapshot.fidelity.fidelity, fidelity, "{}", fixture.name);
        for exclusion in &snapshot.fidelity.exclusions {
            let host_only = exclusion.kind == ExclusionKind::KittyKeyboardHostOnly;
            assert_eq!(
                exclusion.rows == 0,
                host_only,
                "{}: {exclusion:?}",
                fixture.name
            );
        }
    }
}
