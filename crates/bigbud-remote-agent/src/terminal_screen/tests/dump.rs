//! Engine-neutral grid dumps and the cell normalization used by every comparison.
//!
//! Normalization follows xterm.js semantics: a blank cell (no contents, or a space without
//! underline/inverse) only shows its background; a wide-character continuation cell has
//! width 0 and nothing else is compared.

use super::super::ScreenModel;
use super::super::probe::{CellAttrs, Probe, RowRef};
use vt100::Color;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DumpCell {
    pub(crate) text: String,
    pub(crate) width: u8,
    pub(crate) fg: Color,
    pub(crate) bg: Color,
    /// bold, dim, italic, underline, inverse as bits 0..=4.
    pub(crate) flags: u8,
}

impl DumpCell {
    pub(crate) fn blank(bg: Color) -> Self {
        Self {
            text: String::new(),
            width: 1,
            fg: Color::Default,
            bg,
            flags: 0,
        }
    }

    pub(crate) fn continuation() -> Self {
        Self {
            text: String::new(),
            width: 0,
            fg: Color::Default,
            bg: Color::Default,
            flags: 0,
        }
    }

    /// Builds a normalized cell from engine-neutral parts.
    pub(crate) fn normalized(text: &str, wide: bool, attrs: CellAttrs) -> Self {
        let flags = u8::from(attrs.bold)
            | u8::from(attrs.dim) << 1
            | u8::from(attrs.italic) << 2
            | u8::from(attrs.underline) << 3
            | u8::from(attrs.inverse) << 4;
        let visible_space = text == " " && (attrs.underline || attrs.inverse);
        if text.is_empty() || (text == " " && !visible_space) {
            return Self::blank(attrs.bg);
        }
        Self {
            text: text.to_owned(),
            width: if wide { 2 } else { 1 },
            fg: attrs.fg,
            bg: attrs.bg,
            flags,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RowDump {
    pub(crate) cells: Vec<DumpCell>,
    pub(crate) wrapped: bool,
}

impl RowDump {
    pub(crate) fn text(&self) -> String {
        let text: String = self
            .cells
            .iter()
            .map(|cell| {
                if cell.width == 1 && cell.text.is_empty() {
                    " "
                } else {
                    cell.text.as_str()
                }
            })
            .collect();
        text.trim_end().to_owned()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Dump {
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) scrollback: Vec<RowDump>,
    pub(crate) visible: Vec<RowDump>,
    pub(crate) alternate: Option<Vec<RowDump>>,
    pub(crate) cursor: (u16, u16),
    pub(crate) cursor_hidden: bool,
    pub(crate) attrs: CellAttrs,
    pub(crate) saved: (u16, u16),
}

impl Dump {
    /// The rows a viewer currently sees (alternate screen when active).
    pub(crate) fn screen(&self) -> &[RowDump] {
        self.alternate.as_deref().unwrap_or(&self.visible)
    }

    pub(crate) fn cell(&self, row: usize, col: usize) -> Option<&DumpCell> {
        self.screen().get(row).and_then(|r| r.cells.get(col))
    }

    pub(crate) fn line(&self, row: usize) -> String {
        self.screen()
            .get(row)
            .map(RowDump::text)
            .unwrap_or_default()
    }
}

fn row_dump(row: RowRef<'_>, cols: u16) -> RowDump {
    let mut cells = Vec::with_capacity(usize::from(cols));
    for col in 0..cols {
        let cell = match row.cell(col) {
            None => DumpCell::blank(Color::Default),
            Some(cell) if cell.is_wide_continuation() => DumpCell::continuation(),
            Some(cell) => {
                DumpCell::normalized(cell.contents(), cell.is_wide(), CellAttrs::of_cell(cell))
            }
        };
        cells.push(cell);
    }
    RowDump {
        cells,
        wrapped: row.wrapped(),
    }
}

pub(crate) fn dump(model: &ScreenModel) -> Dump {
    let copy = model.copy(0);
    let mut probe = Probe::new(copy.screen);
    let cols = probe.cols();
    let rows = probe.rows();
    let screen = probe.screen();
    let cursor = screen.cursor_position();
    let cursor_hidden = screen.hide_cursor();
    let attrs = CellAttrs::of_screen(screen);
    let mut alternate = None;
    if screen.alternate_screen() {
        let mut alt_rows = Vec::new();
        probe.visit_visible(|row| alt_rows.push(row_dump(row, cols)));
        alternate = Some(alt_rows);
        probe.leave_alternate();
    }
    let scrollback_len = probe.scrollback_len();
    let mut all = Vec::new();
    probe.visit_rows(0, |row| all.push(row_dump(row, cols)));
    let saved = probe.saved_cursor();
    // The position DECRC would restore now (see `model.cursor.rs`).
    let shift = i64::try_from(scrollback_len).unwrap()
        - i64::try_from(model.tracker.saved_scrollback).unwrap();
    let saved_row =
        u16::try_from((i64::from(saved.row) - shift).clamp(0, i64::from(rows) - 1)).unwrap();
    let saved_col = saved.col.min(cols - 1);
    let visible = all.split_off(scrollback_len);
    Dump {
        cols,
        rows,
        scrollback: all,
        visible,
        alternate,
        cursor,
        cursor_hidden,
        attrs,
        saved: (saved_row, saved_col),
    }
}

/// Every cell-level difference between two dumps, as readable lines (empty when equal).
pub(crate) fn diff(left: &Dump, right: &Dump) -> Vec<String> {
    let mut out = Vec::new();
    if (left.cols, left.rows) != (right.cols, right.rows) {
        out.push(format!(
            "geometry {}x{} vs {}x{}",
            left.cols, left.rows, right.cols, right.rows
        ));
        return out;
    }
    diff_rows("scrollback", &left.scrollback, &right.scrollback, &mut out);
    diff_rows("visible", &left.visible, &right.visible, &mut out);
    match (&left.alternate, &right.alternate) {
        (Some(a), Some(b)) => diff_rows("alternate", a, b, &mut out),
        (None, None) => {}
        _ => out.push("alternate screen active on one side only".to_owned()),
    }
    for (what, a, b) in [
        ("cursor", left.cursor, right.cursor),
        ("saved", left.saved, right.saved),
    ] {
        if a != b {
            out.push(format!("{what} {a:?} vs {b:?}"));
        }
    }
    if left.cursor_hidden != right.cursor_hidden {
        out.push("cursor visibility".to_owned());
    }
    if left.attrs != right.attrs {
        out.push(format!("attributes {:?} vs {:?}", left.attrs, right.attrs));
    }
    out
}

pub(crate) fn diff_rows(what: &str, left: &[RowDump], right: &[RowDump], out: &mut Vec<String>) {
    if left.len() != right.len() {
        out.push(format!("{what}: {} rows vs {}", left.len(), right.len()));
    }
    for (index, (a, b)) in left.iter().zip(right).enumerate() {
        for (col, (x, y)) in a.cells.iter().zip(&b.cells).enumerate() {
            if x != y {
                out.push(format!("{what}[{index}][{col}]: {x:?} vs {y:?}"));
            }
        }
    }
}
