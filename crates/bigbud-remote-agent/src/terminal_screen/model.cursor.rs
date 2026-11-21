//! Cursor semantics where `vt100` differs from xterm.js (checked against xterm.js
//! `InputHandler.ts`):
//!
//! - After printing in the last column both engines enter a pending wrap, which `vt100`
//!   reports as a cursor column equal to the width. xterm.js clamps the cursor to the last
//!   column (`_restrictCursor`) before BS, LF/VT/FF, cursor moves, VPA, ICH, DCH, ECH, IL,
//!   DL, RI and after DECRC, and TAB does nothing then; `vt100` keeps the column (text and
//!   tabs are in `model.text.rs`).
//! - IL and DL inside the margins move xterm.js's cursor to the first column.
//! - DECRC restores the row relative to xterm.js's `ybase`, so on the normal screen it
//!   moves up by the lines that scrolled into scrollback since DECSC.

use super::super::marks::MarkKind;
use super::super::probe::CellAttrs;
use super::super::serialize::rows::set_attrs;
use super::feed::Feeder;
use std::io::Write as _;

impl Feeder<'_, '_> {
    pub(super) fn width(&self) -> u16 {
        self.parser.screen().size().1.get()
    }

    /// True when `vt100` holds a pending wrap (flushes first).
    pub(super) fn pending_wrap(&mut self) -> bool {
        self.flush();
        self.parser.screen().cursor_position().1 >= self.width()
    }

    /// xterm.js `_restrictCursor()`: clamp a pending wrap to the last column.
    pub(super) fn restrict_cursor(&mut self) {
        if self.pending_wrap() {
            let mut cha = Vec::with_capacity(8);
            let _ = write!(cha, "\x1b[{}G", self.width());
            self.parser.process(&cha);
        }
    }

    /// DECSC and its aliases, before `vt100` applies them.
    pub(super) fn save_cursor(&mut self) {
        self.flush();
        self.tracker
            .save_cursor(CellAttrs::of_screen(self.parser.screen()));
        if !self.parser.screen().alternate_screen() {
            self.tracker.saved_scrollback = self.parser.screen().scrollback_len();
        }
    }

    /// DECRC and its aliases, before `vt100` applies them: restores the tracked state.
    pub(super) fn restore_cursor(&mut self) {
        let mode_before = self.tracker.unsupported_mode();
        let (attrs, changed) = self.tracker.restore_cursor();
        self.restored_attrs = Some(attrs);
        if changed {
            let active = self.tracker.unsupported != 0;
            self.mark(MarkKind::UnsupportedAttribute, active);
        }
        self.sync_mode_mark(mode_before);
    }

    /// After `vt100` applied DECRC: per-screen attributes (`vt100` keeps one slot for both
    /// screens), the column clamp, and the `ybase` shift.
    pub(super) fn after_restore(&mut self) {
        self.flush();
        if let Some(attrs) = self.restored_attrs.take()
            && attrs != CellAttrs::of_screen(self.parser.screen())
        {
            let mut sgr = String::from("\x1b[m");
            set_attrs(&mut sgr, &mut CellAttrs::default(), attrs);
            self.parser.process(sgr.as_bytes());
        }
        let screen = self.parser.screen();
        let (row, col) = screen.cursor_position();
        let rows = screen.size().0.get();
        // Lines that entered scrollback since DECSC (negative after ED 3 cleared it).
        let shift = if screen.alternate_screen() {
            0
        } else {
            i64::try_from(screen.scrollback_len()).unwrap_or(i64::MAX)
                - i64::try_from(self.tracker.saved_scrollback).unwrap_or(i64::MAX)
        };
        let (low, high) = match (self.tracker.origin, self.tracker.region()) {
            (true, Some(region)) => region,
            _ => (0, rows - 1),
        };
        let shifted = (i64::from(row) - shift).clamp(0, i64::from(rows - 1));
        let shifted = u16::try_from(shifted).unwrap_or(0);
        let target = (shifted.clamp(low, high), col.min(self.width() - 1));
        if target != (row, col) {
            let mut cup = Vec::with_capacity(12);
            self.goto(&mut cup, target.0, target.1);
            self.parser.process(&cup);
        }
    }

    /// Records a transition of the unsupported-mode mark after a mode change.
    pub(super) fn sync_mode_mark(&mut self, before: bool) {
        let now = self.tracker.unsupported_mode();
        if before != now {
            self.mark(MarkKind::UnsupportedMode, now);
        }
    }
}
