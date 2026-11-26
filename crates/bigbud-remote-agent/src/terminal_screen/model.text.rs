//! Printable text and C0 controls inside text, with xterm.js semantics: BS, LF, VT and FF
//! clamp a pending wrap first; TAB does nothing in a pending wrap and follows custom tab
//! stops; a wide character wrapped from the last column blanks that column; and the active
//! character set (`tracker.charsets.rs`) is translated before `vt100` sees the text.

use super::super::marks::MarkKind;
use super::super::scanner::{Span, utf8_len};
use super::super::tracker::Charset;
use super::feed::Feeder;
use std::io::Write as _;

impl Feeder<'_, '_> {
    /// Printable text, translated through the active character set first.
    pub(super) fn text_token(&mut self, raw: &[u8], span: Span) {
        match self.tracker.translation() {
            None if self.tracker.background => self.text_with_background(raw),
            None => self.text(raw, span),
            Some(charset) => {
                let mut scratch = std::mem::take(self.scratch);
                scratch.clear();
                translate(raw, charset, &mut scratch);
                if self.tracker.background {
                    self.text_with_background(&scratch);
                } else {
                    self.text(&scratch, Span::Held);
                }
                *self.scratch = scratch;
            }
        }
    }

    /// Text with C0 controls: BS, LF, VT, FF and TAB observe a pending wrap like xterm.js,
    /// and characters that may be wide are applied one at a time so a wrap from the last
    /// column can be repaired. Everything else stays in one contiguous batch; after a CR
    /// (column 0 until the next printable) no pending wrap is possible, so the common
    /// `\r\n` needs no cursor check.
    pub(super) fn text(&mut self, raw: &[u8], span: Span) {
        let mut from = 0;
        let mut at = 0;
        let mut column_zero = false;
        while let Some(&byte) = raw.get(at) {
            match byte {
                0x0d => column_zero = true,
                0x08 | 0x0a..=0x0c if column_zero => {}
                0x08..=0x0c => {
                    self.forward(raw, span, from, at);
                    from = at + 1;
                    column_zero = false;
                    if byte != 0x09 {
                        self.restrict_cursor();
                        self.forward(raw, span, at, at + 1);
                    } else if !self.tab(1) {
                        self.forward(raw, span, at, at + 1);
                    }
                }
                0xe1.. => {
                    column_zero = false;
                    let next = (at + utf8_len(byte)).min(raw.len());
                    if may_be_wide(raw.get(at..next).unwrap_or_default()) {
                        self.forward(raw, span, from, at);
                        self.flush();
                        let before = self.parser.screen().cursor_position();
                        self.forward(raw, span, at, next);
                        self.flush();
                        self.repair_wide_wrap(before);
                        from = next;
                    }
                    at = next;
                    continue;
                }
                _ => column_zero = false,
            }
            at += 1;
        }
        self.forward(raw, span, from, raw.len());
    }

    fn forward(&mut self, raw: &[u8], span: Span, start: usize, end: usize) {
        if start >= end {
            return;
        }
        match span {
            Span::Chunk(offset, _) => self.pass(Span::Chunk(offset + start, offset + end), &[]),
            Span::Held => self.send(raw.get(start..end).unwrap_or_default()),
        }
    }

    /// xterm.js wraps a wide character that does not fit in the last column and blanks that
    /// column with all current attributes; `vt100` leaves the column's previous contents.
    pub(super) fn repair_wide_wrap(&mut self, before: (u16, u16)) {
        let width = self.width();
        let after = self.parser.screen().cursor_position();
        if (after.0, after.1) != (before.0, before.1 + 1) {
            // Possibly wide (or combining): the screen may now hold wide characters.
            self.tracker.wide_cells = true;
        }
        if before.1 + 1 != width || after.1 != 2 || after.0 == 0 {
            return;
        }
        let row = after.0 - 1;
        // xterm.js leaves an empty cell carrying an underline or inverse; it renders like the
        // space written here, but no snapshot can re-create it, so the rows are reported.
        let screen = self.parser.screen();
        if (screen.underline() || screen.inverse()) && self.tracker.unsupported == 0 {
            self.mark(MarkKind::UnsupportedAttribute, true);
            self.mark(MarkKind::UnsupportedAttribute, false);
        }
        let mut repair = Vec::with_capacity(24);
        self.goto(&mut repair, row, width - 1);
        // A space with the current attributes, like xterm.js's null cell with `curAttr`.
        repair.push(b' ');
        self.goto(&mut repair, after.0, after.1);
        self.parser.process(&repair);
    }

    /// xterm.js turns the other half of a wide character that text overwrites into an empty
    /// cell with the current attributes (`print`); `vt100` keeps the half's own attributes,
    /// or writes a space. They differ through underline, inverse or a changed background, and
    /// no snapshot can re-create such an empty cell, so when the rows `raw` may reach hold a
    /// wide character under those conditions, they are reported.
    pub(super) fn report_wide_overwrites(&mut self, raw: &[u8]) {
        if !self.tracker.wide_cells || self.tracker.unsupported != 0 {
            return;
        }
        self.flush();
        let screen = self.parser.screen();
        let (rows, cols) = (screen.size().0.get(), screen.size().1.get());
        let row = screen.cursor_position().0;
        let visible = screen.underline() || screen.inverse();
        let bg = screen.bgcolor();
        // Rows the text may reach: one per line feed or wrap (bytes over-count characters).
        let feeds = raw
            .iter()
            .filter(|byte| matches!(byte, 0x0a..=0x0c))
            .count();
        let reach = u16::try_from(feeds + raw.len() / usize::from(cols) + 1).unwrap_or(u16::MAX);
        let last = row.saturating_add(reach).min(rows - 1);
        let differs = (row..=last).any(|row| {
            (0..cols).any(|col| {
                screen
                    .cell(row, col)
                    .is_some_and(|cell| cell.is_wide() && (visible || cell.bgcolor() != bg))
            })
        });
        if differs {
            self.mark(MarkKind::UnsupportedAttribute, true);
            self.mark(MarkKind::UnsupportedAttribute, false);
        }
    }

    /// TAB (or CHT with `count`): returns true when handled here, false when `vt100`'s own
    /// default-stop TAB is equivalent and the byte should be forwarded.
    pub(super) fn tab(&mut self, count: u16) -> bool {
        if self.pending_wrap() {
            return true;
        }
        if !self.tracker.custom_tabs_active() && count == 1 {
            return false;
        }
        let (_, col) = self.parser.screen().cursor_position();
        let cols = self.parser.screen().size().1.get();
        let target = self.tracker.next_tab_stop(col, cols, count);
        self.move_to_column(target);
        true
    }

    /// CBT: back `count` tab stops (nothing in a pending wrap, like xterm.js).
    pub(super) fn back_tab(&mut self, count: u16) {
        if self.pending_wrap() {
            return;
        }
        let (_, col) = self.parser.screen().cursor_position();
        let target = self.tracker.previous_tab_stop(col, count);
        self.move_to_column(target);
    }

    fn move_to_column(&mut self, col: u16) {
        let mut cha = Vec::with_capacity(10);
        let _ = write!(cha, "\x1b[{}G", u32::from(col) + 1);
        self.parser.process(&cha);
    }
}

/// Whether a character may be wide under xterm.js's Unicode 11 widths (a superset: a
/// false positive only costs the per-character path). Box drawing, arrows and general
/// punctuation are narrow; the wide symbols between U+231A and U+2B55 are listed.
fn may_be_wide(encoded: &[u8]) -> bool {
    let Some(symbol) = std::str::from_utf8(encoded)
        .ok()
        .and_then(|text| text.chars().next())
    else {
        return true;
    };
    const WIDE_SYMBOLS: [(u32, u32); 34] = [
        (0x231A, 0x231B),
        (0x2329, 0x232A),
        (0x23E9, 0x23EC),
        (0x23F0, 0x23F0),
        (0x23F3, 0x23F3),
        (0x25FD, 0x25FE),
        (0x2614, 0x2615),
        (0x2648, 0x2653),
        (0x267F, 0x267F),
        (0x2693, 0x2693),
        (0x26A1, 0x26A1),
        (0x26AA, 0x26AB),
        (0x26BD, 0x26BE),
        (0x26C4, 0x26C5),
        (0x26CE, 0x26CE),
        (0x26D4, 0x26D4),
        (0x26EA, 0x26EA),
        (0x26F2, 0x26F3),
        (0x26F5, 0x26F5),
        (0x26FA, 0x26FA),
        (0x26FD, 0x26FD),
        (0x2705, 0x2705),
        (0x270A, 0x270B),
        (0x2728, 0x2728),
        (0x274C, 0x274C),
        (0x274E, 0x274E),
        (0x2753, 0x2755),
        (0x2757, 0x2757),
        (0x2795, 0x2797),
        (0x27B0, 0x27B0),
        (0x27BF, 0x27BF),
        (0x2B1B, 0x2B1C),
        (0x2B50, 0x2B50),
        (0x2B55, 0x2B55),
    ];
    match u32::from(symbol) {
        0x1160..=0x2319 => false,
        code @ 0x231A..=0x2E7F => WIDE_SYMBOLS
            .iter()
            .any(|(low, high)| (*low..=*high).contains(&code)),
        _ => true,
    }
}

/// Replaces what the active character set maps (only ASCII bytes are mapped, as in
/// xterm.js's `print`); every other byte is copied.
fn translate(raw: &[u8], charset: Charset, out: &mut Vec<u8>) {
    let mut buffer = [0u8; 4];
    for byte in raw {
        match charset.map(*byte) {
            Some(symbol) => out.extend_from_slice(symbol.encode_utf8(&mut buffer).as_bytes()),
            None => out.push(*byte),
        }
    }
}
