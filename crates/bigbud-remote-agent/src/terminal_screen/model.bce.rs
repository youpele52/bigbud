//! Background colour erase (BCE) and SU, as xterm.js applies them.
//!
//! xterm.js (terminfo `bce`) fills every line or cell it scrolls in, inserts or exposes with
//! the current background colour; `vt100` uses the default background. Programs such as vim
//! rely on BCE for coloured backgrounds, so the model repairs each affected line or cell
//! right after `vt100` applies the operation. Only output written while a background colour
//! may be set takes this path. Separately, xterm.js SU (`CSI n S`) discards the lines it
//! scrolls out, while `vt100` pushes them into scrollback; SU is emulated with DL.

use super::super::probe::{CellAttrs, wrap_cell};
use super::super::scanner::{Span, utf8_len};
use super::super::serialize::rows::set_attrs;
use super::feed::Feeder;
use std::io::Write as _;

impl Feeder<'_, '_> {
    /// True when `vt100` currently has a background colour (flushes first).
    fn erasing_with_background(&mut self) -> bool {
        self.flush();
        self.parser.screen().bgcolor() != vt100::Color::Default
    }

    /// The scroll margins of the active screen (0-based, inclusive).
    fn margins(&self) -> (u16, u16) {
        let rows = self.parser.screen().size().0.get();
        self.tracker.region().unwrap_or((0, rows - 1))
    }

    fn cursor_now(&self) -> (u16, u16) {
        self.parser.screen().cursor_position()
    }

    /// Text written with a background colour: line feeds and wraps that scroll at the bottom
    /// margin fill the new line with that colour.
    pub(super) fn text_with_background(&mut self, raw: &[u8]) {
        if !self.erasing_with_background() {
            self.parser.process(raw);
            return;
        }
        let mut rest = raw;
        while let Some(&lead) = rest.first() {
            let (unit, tail) = rest.split_at(utf8_len(lead).min(rest.len()));
            rest = tail;
            if lead == 0x09 && self.tab(1) {
                continue;
            }
            if matches!(lead, 0x08 | 0x0a..=0x0c) {
                self.restrict_cursor();
            }
            let before = self.cursor_now();
            let bottom = self.margins().1;
            self.parser.process(unit);
            if lead >= 0xe1 {
                self.repair_wide_wrap(before);
            }
            let after = self.cursor_now();
            if before.0 != bottom || after.0 != bottom {
                continue;
            }
            match lead {
                b'\n' | 0x0b | 0x0c => self.parser.process(b"\x1b[2K"),
                0x00..=0x1f | 0x7f => {}
                // A printable character that moved the cursor back wrapped and scrolled.
                _ if after.1 < before.1 => self.parser.process(b"\x1b[K"),
                _ => {}
            }
        }
    }

    /// RI at the top margin scrolls down and exposes a new top line.
    pub(super) fn index_with_background(&mut self, raw: &[u8], span: Span) {
        if !self.erasing_with_background() {
            self.pass(span, raw);
            return;
        }
        let before = self.cursor_now();
        let top = self.margins().0;
        self.pass(span, raw);
        self.flush();
        if before.0 == top && self.cursor_now().0 == top {
            self.parser.process(b"\x1b[2K");
        }
    }

    /// SU, IL, DL, ICH and DCH (`final_byte` S, L, M, @, P); xterm.js SD does not erase
    /// with the background colour.
    pub(super) fn shift(&mut self, final_byte: u8, count: u16, raw: &[u8], span: Span) {
        let background = self.erasing_with_background();
        if final_byte != b'S' && !background {
            self.pass(span, raw);
            return;
        }
        let (row, col) = self.cursor_now();
        let (top, bottom) = self.margins();
        let cols = self.parser.screen().size().1.get();
        let count = count.max(1);
        let mut repair = Vec::new();
        if final_byte == b'S' {
            // DL at the top margin removes the same lines without keeping them.
            self.goto(&mut repair, top, 0);
            let _ = write!(repair, "\x1b[{count}M");
        } else {
            self.pass(span, raw);
            self.flush();
        }
        let span_of = |first: u16| (first, first.saturating_add(count - 1).min(bottom));
        let inside = (top..=bottom).contains(&row);
        let lines = match final_byte {
            b'S' => Some((bottom.saturating_sub(count - 1).max(top), bottom)),
            b'L' if inside => Some(span_of(row)),
            b'M' if inside => Some((bottom.saturating_sub(count - 1).max(row), bottom)),
            _ => None,
        };
        if background {
            for line in lines.into_iter().flat_map(|(first, last)| first..=last) {
                self.goto(&mut repair, line, 0);
                repair.extend_from_slice(b"\x1b[2K");
            }
            // ICH exposes `count` cells at the cursor; DCH exposes them at the right edge.
            let exposed = match final_byte {
                b'@' => Some(col),
                b'P' => Some(cols.saturating_sub(count).max(col)),
                _ => None,
            };
            if let Some(start) = exposed.filter(|start| *start < cols) {
                self.goto(&mut repair, row, start);
                let _ = write!(repair, "\x1b[{}X", count.min(cols - start));
            }
        }
        if repair.is_empty() {
            return;
        }
        let after = if final_byte == b'S' {
            (row, col)
        } else {
            self.cursor_now()
        };
        self.parser.process(&repair);
        self.return_to(after);
    }

    /// CUP to a 0-based position, relative to the top margin in origin mode.
    pub(super) fn goto(&self, out: &mut Vec<u8>, row: u16, col: u16) {
        let top = if self.tracker.origin {
            self.margins().0
        } else {
            0
        };
        let _ = write!(
            out,
            "\x1b[{};{}H",
            u32::from(row.saturating_sub(top)) + 1,
            u32::from(col) + 1
        );
    }

    /// Puts the cursor back exactly, including a pending wrap past the last column.
    pub(super) fn return_to(&mut self, (row, col): (u16, u16)) {
        let mut out = Vec::new();
        let Some(cell) = wrap_cell(self.parser.screen(), row, col) else {
            self.goto(&mut out, row, col);
            self.parser.process(&out);
            return;
        };
        let current = CellAttrs::of_screen(self.parser.screen());
        let mut text = String::from("\x1b[m");
        let mut attrs = CellAttrs::default();
        set_attrs(&mut text, &mut attrs, cell.attrs);
        text.push_str(&cell.contents);
        text.push_str("\x1b[m");
        attrs = CellAttrs::default();
        set_attrs(&mut text, &mut attrs, current);
        self.goto(&mut out, row, cell.col);
        out.extend_from_slice(text.as_bytes());
        self.parser.process(&out);
    }
}
