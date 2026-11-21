//! M0 gate: the same corpus against an `alacritty_terminal` 0.26.0 prototype (§15 R1, §19).
//!
//! Both engines are captured into the same normalized dump and compared cell by cell, on the
//! rows the pass criteria cover (rows written before the last width change are excluded, and
//! the inactive normal screen is skipped because alacritty keeps it private). Comparison is
//! in the attribute space both engines share; attributes only alacritty stores (strikeout,
//! underline styles, ...) are the `UnsupportedAttributes` exclusion on the `vt100` side.

use super::super::probe::CellAttrs;
use super::super::{ExclusionKind, SnapshotLimits};
use super::dump::{Dump, DumpCell, RowDump, diff_rows, dump};
use super::fixtures::{Fixture, Step, corpus};
use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, TermMode};
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor, Processor};
use vt100::Color;

fn color(color: AColor) -> Color {
    match color {
        AColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
        AColor::Indexed(index) => Color::Idx(index),
        AColor::Named(named) => match named as usize {
            index @ 0..=15 => Color::Idx(u8::try_from(index).unwrap_or(0)),
            _ if named == NamedColor::Foreground || named == NamedColor::Background => {
                Color::Default
            }
            _ => Color::Default,
        },
    }
}

fn row(term: &Term<VoidListener>, line: i32) -> RowDump {
    let grid = term.grid();
    let columns = grid.columns();
    let source = &grid[Line(line)];
    let mut cells = Vec::with_capacity(columns);
    for col in 0..columns {
        let cell = &source[Column(col)];
        let flags = cell.flags;
        let normalized = if flags.contains(Flags::WIDE_CHAR_SPACER) {
            DumpCell::continuation()
        } else if flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) || cell.c == '\t' {
            // alacritty keeps a tab character in the first cell a tab skipped (for copying);
            // it renders blank, like xterm.js.
            DumpCell::blank(color(cell.bg))
        } else {
            let mut text = cell.c.to_string();
            text.extend(cell.zerowidth().unwrap_or_default());
            let attrs = CellAttrs {
                fg: color(cell.fg),
                bg: color(cell.bg),
                bold: flags.contains(Flags::BOLD),
                dim: flags.contains(Flags::DIM),
                italic: flags.contains(Flags::ITALIC),
                underline: flags.intersects(Flags::ALL_UNDERLINES),
                inverse: flags.contains(Flags::INVERSE),
            };
            DumpCell::normalized(&text, flags.contains(Flags::WIDE_CHAR), attrs)
        };
        cells.push(normalized);
    }
    let wrapped = source[Column(columns - 1)].flags.contains(Flags::WRAPLINE);
    RowDump { cells, wrapped }
}

/// Runs a fixture through alacritty and returns (all rows oldest first, cursor, alternate).
fn run(fixture: &Fixture) -> (Vec<RowDump>, (u16, u16), bool) {
    let config = Config {
        scrolling_history: fixture.scrollback,
        ..Config::default()
    };
    let size = TermSize::new(usize::from(fixture.cols), usize::from(fixture.rows));
    let mut term = Term::new(config, &size, VoidListener);
    let mut processor: Processor = Processor::new();
    for step in &fixture.steps {
        match step {
            Step::Feed(bytes) => processor.advance(&mut term, bytes),
            Step::Resize(cols, rows) => {
                term.resize(TermSize::new(usize::from(*cols), usize::from(*rows)));
            }
        }
    }
    let grid = term.grid();
    let history = i32::try_from(grid.history_size()).unwrap_or(0);
    let lines = i32::try_from(grid.screen_lines()).unwrap_or(0);
    let rows = (-history..lines).map(|line| row(&term, line)).collect();
    let cursor = grid.cursor.point;
    let col = cursor.column.0 + usize::from(grid.cursor.input_needs_wrap);
    let cursor = (
        u16::try_from(cursor.line.0).unwrap_or(0),
        u16::try_from(col).unwrap_or(0),
    );
    (rows, cursor, term.mode().contains(TermMode::ALT_SCREEN))
}

/// Cell differences on the rows the pass criteria cover.
fn compare(fixture: &Fixture) -> Vec<String> {
    let model = fixture.run();
    let ours: Dump = dump(&model);
    let snapshot = model
        .snapshot(&SnapshotLimits::default())
        .expect("snapshot");
    let excluded = snapshot
        .fidelity
        .exclusions
        .iter()
        .filter(|e| e.kind == ExclusionKind::ReflowAfterWidthChange)
        .map(|e| usize::try_from(e.rows).unwrap_or(usize::MAX))
        .sum::<usize>();
    let (theirs, cursor, alternate) = run(fixture);
    let mut out = Vec::new();
    if alternate != ours.alternate.is_some() {
        out.push("alternate screen state".to_owned());
        return out;
    }
    let mine: Vec<RowDump> = match &ours.alternate {
        Some(alt) => alt.clone(),
        None => ours
            .scrollback
            .iter()
            .chain(&ours.visible)
            .cloned()
            .collect(),
    };
    let skip_mine = excluded.min(mine.len());
    let skip_theirs = theirs.len().saturating_sub(mine.len() - skip_mine);
    let mine = mine.get(skip_mine..).unwrap_or_default();
    let theirs = theirs.get(skip_theirs..).unwrap_or_default();
    diff_rows("rows", mine, theirs, &mut out);
    if cursor != ours.cursor {
        out.push(format!("cursor {:?} vs alacritty {cursor:?}", ours.cursor));
    }
    out
}

/// Differences the prototype comparison is expected to find, per fixture, with the reason.
/// Each is a `vt100` gap that is reported through `fidelity`, or an alacritty-specific
/// behaviour where `vt100` matches xterm.js.
fn documented(name: &str, difference: &str) -> Option<&'static str> {
    match name {
        // xterm.js and alacritty render bold together with dim; `vt100` keeps only one.
        "unsupported_attributes"
            if difference.contains("rows[1][5]") || difference.contains("rows[1][6]") =>
        {
            Some("bold+dim (UnsupportedAttributes)")
        }
        // alacritty implements neither DECSET 47 nor 1047; xterm.js and the model switch
        // screens, so "x" lands on the alternate screen there.
        "alternate_screen_exit" if difference.contains("rows[1][7]") => Some("alacritty: no ?47"),
        // alacritty withholds output inside a synchronized update until `?2026l`; xterm.js
        // applies it to the buffer at once and only defers rendering, like the model.
        "dec2026_synchronized_output" => Some("alacritty: buffers ?2026 updates"),
        // xterm.js `_restrictCursor` clamps a pending wrap before BS/LF/ECH/CUU and TAB is a
        // no-op there; alacritty keeps its wrap flag, so later text lands elsewhere.
        "pending_wrap_is_clamped_like_xterm" => Some("alacritty: pending-wrap handling"),
        // xterm.js IL/DL move the cursor to column 0; alacritty keeps the column.
        "insert_delete_lines_home_the_column" => Some("alacritty: IL/DL keep the column"),
        // xterm.js SD exposes default-attribute lines; alacritty fills them with the bg.
        "scroll_up_discards_and_scroll_down_is_not_bce" => Some("alacritty: SD uses BCE"),
        _ => None,
    }
}

#[test]
fn alacritty_prototype_runs_the_same_corpus() {
    let mut undocumented = Vec::new();
    let mut summary = Vec::new();
    for fixture in corpus() {
        let differences = compare(&fixture);
        let (known, unknown): (Vec<_>, Vec<_>) = differences
            .iter()
            .partition(|d| documented(fixture.name, d).is_some());
        summary.push(format!(
            "{:<40} diffs={:<3} documented={:<3}",
            fixture.name,
            differences.len(),
            known.len()
        ));
        undocumented.extend(
            unknown
                .into_iter()
                .map(|d| format!("{}: {d}", fixture.name)),
        );
    }
    println!(
        "vt100 vs alacritty_terminal 0.26.0 prototype:\n{}",
        summary.join("\n")
    );
    assert!(undocumented.is_empty(), "{undocumented:#?}");
}
