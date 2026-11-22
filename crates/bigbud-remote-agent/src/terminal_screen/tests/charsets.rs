//! Character set state across snapshots: designations, shifts and the saved copies are
//! re-created exactly when xterm.js's growing set array allows it, and reported otherwise.

use super::super::{ExclusionKind, Fidelity, ScreenModel, SnapshotLimits};
use super::corpus::restore_from_snapshot;
use super::dump::{diff, dump};

fn model(input: &str) -> ScreenModel {
    let mut model = ScreenModel::new(12, 4, 10).expect("model");
    let _ = model.feed(input.as_bytes());
    model
}

fn charset_state_reported(model: &ScreenModel) -> (bool, Fidelity) {
    let snapshot = model
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    let reported = snapshot
        .fidelity
        .exclusions
        .iter()
        .any(|exclusion| exclusion.kind == ExclusionKind::CharsetState);
    (reported, snapshot.fidelity.fidelity)
}

/// Feeds `continuation` to the original and to a model restored from its snapshot.
fn continues_identically(input: &str, continuation: &str) {
    let mut original = model(input);
    let mut restored = restore_from_snapshot(&original);
    assert_eq!(
        original.tracker.charsets, restored.tracker.charsets,
        "{input:?}"
    );
    let _ = original.feed(continuation.as_bytes());
    let _ = restored.feed(continuation.as_bytes());
    let differences = diff(&dump(&original), &dump(&restored));
    assert!(differences.is_empty(), "{input:?}: {differences:#?}");
}

#[test]
fn designations_and_shifts_round_trip() {
    for input in [
        "\x1b)A\x1b*0\x1bn",
        "\x1b+K\x1bo",
        "\x1b(0\x1b)0\x0e",
        "\x1b[?2h",
        "\x1b(4\x1b%G",
    ] {
        continues_identically(input, "q#[\x0fq\x0eq\x1bnq\x1boq");
        assert_eq!(
            charset_state_reported(&model(input)),
            (false, Fidelity::Full)
        );
    }
}

#[test]
fn saved_copies_keep_their_length() {
    // Normal screen: DECSC copied one set; G1 designated later survives DECRC.
    continues_identically("\x1b(0\x1b7\x1b(B", "\x1b)0\x1b8\x0eq");
    // The alternate screen's empty copy is written before the normal screen's longer one,
    // so G0 designated there survives its DECRC.
    let input = "\x1b[?47h\x1b[2;3H\x1b7\x1b[?47l\x1b(0\x1b7\x1b(B";
    continues_identically(input, "\x1b[?47h\x1b(0\x1b8q");
    assert_eq!(
        charset_state_reported(&model(input)),
        (false, Fidelity::Full)
    );
    // The same while the alternate screen is active.
    continues_identically(&format!("{input}\x1b[?47h"), "\x1b(0\x1b8q");
}

#[test]
fn a_shorter_current_array_is_reported() {
    // DECSTR empties the current set array but keeps the saved copy (two sets), which no
    // snapshot can express: the restored array would already hold two sets.
    let input = "\x1b)0\x1b7\x1b[!p";
    let original = model(input);
    assert_eq!(original.tracker.charsets.len(), 0);
    assert_eq!(charset_state_reported(&original), (true, Fidelity::Trimmed));
}
