//! Golden outputs for the cross-engine harness (S4 `TerminalScreenFidelity.harness.ts`),
//! one pretty JSON document per corpus fixture in `tests/goldens/<fixture>.golden` (not
//! `.json`, so repository formatters leave them byte-exact). They also pin `vt100`: any
//! upgrade that changes a snapshot fails here and must be reviewed deliberately.
//!
//! Regenerate with `BIGBUD_UPDATE_SCREEN_GOLDENS=1 cargo test -p bigbud-remote-agent
//! --locked terminal_screen::tests::goldens`.
//!
//! Harness contract (xterm.js is the reference engine):
//! 1. `reference`: `@xterm/headless` at `geometry.cols`×`geometry.rows` with
//!    `scrollback = geometry.scrollback`; apply `steps` in order (`feed` strings via
//!    `write`, `resize` via `resize(cols, rows)`).
//! 2. `restored`: a fresh `@xterm/headless` at `snapshot.cols`×`snapshot.rows` (equal
//!    geometry, N7); write `snapshot.ansi`, then the bytes of `snapshot.pendingEscapeTailHex`.
//! 3. Compare `reference` and `restored` cell by cell on the visible screen and on the
//!    scrollback rows, skipping `snapshot.reflowRows` rows at the top of scrollback followed
//!    by screen (rows written before the last width change): character, width, fg, bg,
//!    bold, dim, italic, underline, inverse. An empty cell and a space are equivalent and
//!    compare only their background, unless underline or inverse makes them visible (then
//!    compare them as a space with all attributes). Also compare the cursor, cursor
//!    visibility, and xterm-visible modes
//!    (application cursor and keypad, bracketed paste, mouse tracking and encoding, focus
//!    1004, insert, wraparound, origin, reverse wraparound, synchronized output, DECSCNM).
//! 4. Differences are allowed only in rows covered by the categories in
//!    `snapshot.exclusions`: the rows listed in `snapshot.excludedRows` (indices into
//!    scrollback followed by screen) and the whole alternate screen when
//!    `snapshot.excludedAlternate`. Kitty keyboard flags are host state.
//! 5. Compare `restored` with `expected` (the model's own normalized grid) as well, so an
//!    engine-specific divergence is caught even where both xterm.js instances agree.

use super::super::SnapshotLimits;
use super::dump::{Dump, DumpCell, RowDump, dump};
use super::fixtures::{Fixture, Step, corpus};
use serde_json::{Value, json};
use std::path::PathBuf;
use vt100::Color;

fn color(color: Color) -> Value {
    match color {
        Color::Default => json!("default"),
        Color::Idx(index) => json!(index),
        Color::Rgb(r, g, b) => json!(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

fn cell(cell: &DumpCell) -> Value {
    json!([
        cell.text,
        cell.width,
        color(cell.fg),
        color(cell.bg),
        cell.flags
    ])
}

fn rows(rows: &[RowDump]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| Value::Array(row.cells.iter().map(cell).collect()))
            .collect(),
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn golden(fixture: &Fixture) -> String {
    let model = fixture.run();
    let snapshot = model
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    let expected: Dump = dump(&model);
    let steps: Vec<Value> = fixture
        .steps
        .iter()
        .map(|step| match step {
            Step::Feed(bytes) => json!({ "feed": String::from_utf8_lossy(bytes) }),
            Step::Resize(cols, rows) => json!({ "resize": [cols, rows] }),
        })
        .collect();
    let exclusions: Vec<Value> = snapshot
        .fidelity
        .exclusions
        .iter()
        .map(|e| json!({ "kind": e.kind.as_str(), "rows": e.rows }))
        .collect();
    let reflow_rows = snapshot
        .fidelity
        .exclusions
        .iter()
        .filter(|e| e.kind.as_str() == "reflow_after_width_change")
        .map(|e| e.rows)
        .sum::<u32>();
    // Row indices (scrollback then screen) that may differ for a documented reason.
    let emitted = u64::from(snapshot.scrollback_rows) + u64::from(snapshot.rows);
    let excluded_rows: Vec<u64> = (0..emitted)
        .filter(|row| snapshot.restored_marks.covers(*row))
        .collect();
    let document = json!({
        "fixture": fixture.name,
        "geometry": { "cols": fixture.cols, "rows": fixture.rows, "scrollback": fixture.scrollback },
        "steps": steps,
        "snapshot": {
            "cols": snapshot.cols,
            "rows": snapshot.rows,
            "scrollbackRows": snapshot.scrollback_rows,
            "alternateScreen": snapshot.alternate_screen,
            "fidelity": snapshot.fidelity.fidelity.as_str(),
            "trimmedRows": snapshot.fidelity.trimmed_rows,
            "exclusions": exclusions,
            "reflowRows": reflow_rows,
            "excludedRows": excluded_rows,
            "excludedAlternate": snapshot.alternate_screen && snapshot.restored_marks.alt_covered(),
            "ansi": snapshot.ansi,
            "pendingEscapeTailHex": hex(&snapshot.pending_escape_tail),
            "sha256": hex(&snapshot.sha256()),
        },
        "expected": {
            "cursor": [expected.cursor.0, expected.cursor.1],
            "cursorHidden": expected.cursor_hidden,
            "scrollback": rows(&expected.scrollback),
            "screen": rows(&expected.visible),
            "alternate": expected.alternate.as_deref().map(rows),
        },
    });
    let mut text = String::new();
    write_value(&mut text, &document, 0);
    text.push('\n');
    text
}

/// Pretty JSON with one line per screen row: arrays of scalars, or of arrays of scalars,
/// stay on one line; objects and other arrays are indented.
fn write_value(out: &mut String, value: &Value, indent: usize) {
    let flat = |value: &Value| !matches!(value, Value::Array(_) | Value::Object(_));
    let row_like = |items: &[Value]| {
        items.iter().all(|item| match item {
            Value::Array(inner) => inner.iter().all(flat),
            other => flat(other),
        })
    };
    let pad = "  ".repeat(indent + 1);
    match value {
        Value::Array(items) if items.is_empty() || row_like(items) => {
            out.push_str(&serde_json::to_string(value).expect("json"));
        }
        Value::Array(items) => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                out.push_str(&pad);
                write_value(out, item, indent + 1);
                out.push_str(if index + 1 < items.len() { ",\n" } else { "\n" });
            }
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        Value::Object(map) => {
            out.push_str("{\n");
            for (index, (key, item)) in map.iter().enumerate() {
                out.push_str(&pad);
                out.push_str(&serde_json::to_string(key).expect("json"));
                out.push_str(": ");
                write_value(out, item, indent + 1);
                out.push_str(if index + 1 < map.len() { ",\n" } else { "\n" });
            }
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
        scalar => out.push_str(&serde_json::to_string(scalar).expect("json")),
    }
}

#[test]
fn goldens_match_the_corpus() {
    let directory =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/terminal_screen/tests/goldens");
    let update = std::env::var_os("BIGBUD_UPDATE_SCREEN_GOLDENS").is_some();
    let mut stale = Vec::new();
    for fixture in corpus() {
        let path = directory.join(format!("{}.golden", fixture.name));
        let text = golden(&fixture);
        if update {
            std::fs::create_dir_all(&directory).expect("create goldens directory");
            std::fs::write(&path, &text).expect("write golden");
        } else if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
            stale.push(fixture.name);
        }
    }
    assert!(
        stale.is_empty(),
        "stale goldens (regenerate and review): {stale:?}"
    );
}

/// `BIGBUD_SCREEN_EXPORT_RANDOM=<dir>` writes randomized-stream goldens (same format) so
/// the cross-engine harness can run them too (`BIGBUD_SCREEN_EXPORT_COUNT`, default 200,
/// from seed `BIGBUD_SCREEN_EXPORT_SEED`, default 1); without it the test does nothing.
#[test]
fn export_random_stream_goldens() {
    let Some(directory) = std::env::var_os("BIGBUD_SCREEN_EXPORT_RANDOM").map(PathBuf::from) else {
        return;
    };
    std::fs::create_dir_all(&directory).expect("create export directory");
    let count = std::env::var("BIGBUD_SCREEN_EXPORT_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200u64);
    let first = std::env::var("BIGBUD_SCREEN_EXPORT_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1u64);
    for seed in first..first.saturating_add(count) {
        let (cols, rows) = (
            u16::try_from(8 + seed % 40).unwrap(),
            u16::try_from(2 + seed % 9).unwrap(),
        );
        let fixture = Fixture {
            name: "random",
            cols,
            rows,
            scrollback: 40,
            steps: vec![Step::Feed(super::random::stream(
                seed, cols, rows, 250, false,
            ))],
            exclusions: &[],
            expect: |_, _, _| {},
        };
        std::fs::write(
            directory.join(format!("random_{seed:04}.golden")),
            golden(&fixture),
        )
        .expect("write");
    }
}
