//! Row and attribute encoding. Each row starts and ends with default attributes, so the
//! serializer can drop whole scrollback rows from the front without re-encoding the rest.

use super::super::probe::{CellAttrs, RowRef};
use std::fmt::Write as _;
use vt100::Color;

/// Writes `CSI 0;…m` for `target` when it differs from the output's current attributes.
pub(crate) fn set_attrs(out: &mut String, current: &mut CellAttrs, target: CellAttrs) {
    if *current == target {
        return;
    }
    out.push_str("\x1b[0");
    for (on, code) in [
        (target.bold, ";1"),
        (target.dim, ";2"),
        (target.italic, ";3"),
        (target.underline, ";4"),
        (target.inverse, ";7"),
    ] {
        if on {
            out.push_str(code);
        }
    }
    push_color(out, target.fg, 30, 90, 38);
    push_color(out, target.bg, 40, 100, 48);
    out.push('m');
    *current = target;
}

fn push_color(out: &mut String, color: Color, base: u16, bright: u16, extended: u16) {
    // Writing into a String cannot fail.
    let _ = match color {
        Color::Default => Ok(()),
        Color::Idx(index @ 0..=7) => write!(out, ";{}", base + u16::from(index)),
        Color::Idx(index @ 8..=15) => write!(out, ";{}", bright + u16::from(index) - 8),
        Color::Idx(index) => write!(out, ";{extended};5;{index}"),
        Color::Rgb(red, green, blue) => write!(out, ";{extended};2;{red};{green};{blue}"),
    };
}

pub(crate) fn reset_attrs(out: &mut String, current: &mut CellAttrs) {
    if *current != CellAttrs::default() {
        out.push_str("\x1b[m");
        *current = CellAttrs::default();
    }
}

/// Writes one row's cells starting at column 0, leaving default attributes.
///
/// `after_wrap` means the previous row wrapped into this one: the client cursor is in the
/// pending-wrap state, so the first cell must be printed (a cursor move would cancel the
/// wrap). A wrapped row ends with a printed last cell, so the next print wraps. When that
/// first print scrolls with a background colour, xterm.js fills the new line with it (BCE),
/// so such rows erase their default-background blanks instead of skipping them.
pub(crate) fn write_row(out: &mut String, row: RowRef<'_>, cols: u16, after_wrap: bool) {
    let erase_defaults = after_wrap;
    let wrapped = row.wrapped();
    let mut attrs = CellAttrs::default();
    let mut must_print = after_wrap;
    let mut blank_run: Option<(u16, Color)> = None;
    let mut col = 0u16;
    while col < cols {
        let cell = row.cell(col);
        if cell.is_some_and(vt100::Cell::is_wide_continuation) {
            col += 1;
            continue;
        }
        let contents = cell.filter(|cell| cell.has_contents());
        let Some(cell) = contents else {
            let bg = cell.map_or(Color::Default, vt100::Cell::bgcolor);
            let last_of_wrapped = wrapped && col + 1 == cols;
            if must_print || last_of_wrapped {
                flush_blanks(out, &mut attrs, blank_run.take(), erase_defaults);
                set_attrs(out, &mut attrs, CellAttrs::blank(bg));
                out.push(' ');
                must_print = false;
            } else {
                blank_run = match blank_run {
                    Some((length, run_bg)) if run_bg == bg => Some((length + 1, bg)),
                    other => {
                        flush_blanks(out, &mut attrs, other, erase_defaults);
                        Some((1, bg))
                    }
                };
            }
            col += 1;
            continue;
        };
        flush_blanks(out, &mut attrs, blank_run.take(), erase_defaults);
        set_attrs(out, &mut attrs, CellAttrs::of_cell(cell));
        out.push_str(cell.contents());
        must_print = false;
        col += if cell.is_wide() { 2 } else { 1 };
    }
    // Trailing blanks of an unwrapped row only matter when they carry a background colour
    // (or may have been filled by BCE).
    if let Some((length, bg)) = blank_run
        && (bg != Color::Default || erase_defaults)
    {
        set_attrs(out, &mut attrs, CellAttrs::blank(bg));
        let _ = write!(out, "\x1b[{length}X");
    }
    reset_attrs(out, &mut attrs);
}

/// Mid-row blanks: erase (ECH keeps the cursor) with the run's background, then move past.
fn flush_blanks(
    out: &mut String,
    attrs: &mut CellAttrs,
    run: Option<(u16, Color)>,
    erase_defaults: bool,
) {
    let Some((length, bg)) = run else {
        return;
    };
    if bg != Color::Default || erase_defaults {
        set_attrs(out, attrs, CellAttrs::blank(bg));
        let _ = write!(out, "\x1b[{length}X");
    }
    let _ = write!(out, "\x1b[{length}C");
}

/// UTF-16 code units of UTF-8 text: one per scalar, two for scalars outside the BMP.
pub(crate) fn utf16_units(text: &str) -> usize {
    text.bytes()
        .map(|byte| match byte {
            0x80..=0xbf => 0,
            0xf0..=0xff => 2,
            _ => 1,
        })
        .sum()
}
