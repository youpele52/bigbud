//! DECSET/DECRST and DECRQM. Screen switches are rewritten so `vt100` matches xterm.js:
//! xterm.js clears the alternate screen on every entry and carries the cursor between
//! screens; `vt100` clears only on `?1049h`, keeps per-screen cursors, ignores `?1047` and
//! `?1048`, and re-clears on `?1049h` while already on the alternate screen.

use super::super::query::{DetectedQuery, ModeState};
use super::super::scanner::{Params, Span};
use super::feed::Feeder;
use std::io::Write as _;
use vt100::{MouseProtocolEncoding, MouseProtocolMode};

impl Feeder<'_, '_> {
    pub(super) fn private_modes(&mut self, params: &Params, enable: bool, raw: &[u8], span: Span) {
        let modes = || {
            params
                .groups()
                .map(|group| group.first().copied().unwrap_or(0))
        };
        let mode_before = self.tracker.unsupported_mode();
        for mode in modes() {
            let _tracked = self.tracker.set_private_mode(mode, enable);
        }
        self.sync_mode_mark(mode_before);
        if !modes().any(|mode| matches!(mode, 47 | 1047 | 1048 | 1049)) {
            self.pass(span, raw);
            return;
        }
        // `vt100` applies multi-parameter DECSET one parameter at a time, so splitting the
        // sequence is equivalent; only the screen-switch parameters change.
        for mode in modes() {
            match (mode, enable) {
                (47 | 1047 | 1049, true) => self.enter_alternate(mode == 1049),
                (47 | 1047 | 1049, false) => self.leave_alternate(mode == 1049),
                (1048, true) => {
                    self.save_cursor();
                    self.send(b"\x1b7");
                }
                (1048, false) => {
                    self.restore_cursor();
                    self.send(b"\x1b8");
                    self.after_restore();
                }
                (other, _) => {
                    let mut single = Vec::with_capacity(10);
                    let suffix = if enable { 'h' } else { 'l' };
                    // Writing into a Vec cannot fail.
                    let _ = write!(single, "\x1b[?{other}{suffix}");
                    self.send(&single);
                }
            }
        }
    }

    fn enter_alternate(&mut self, save: bool) {
        if self.tracker.alt_active {
            // xterm.js only saves the cursor; the alternate screen is not cleared again.
            if save {
                self.save_cursor();
                self.send(b"\x1b7");
            }
            return;
        }
        let (row, col) = self.cursor();
        let window = self.window();
        if save {
            // DECSC lands on the normal screen, before the switch (as in xterm.js).
            self.save_cursor();
        }
        self.tracker.switch_screen(true, window);
        if save {
            self.tracker.regions[1] = None;
            // xterm.js fills the new alternate screen with the current background colour.
            self.send(b"\x1b[?1049h\x1b[2J");
        } else {
            self.send(b"\x1b[?47h\x1b[2J");
        }
        // xterm.js copies the cursor between buffers, a pending wrap included.
        self.flush();
        self.return_to((row, col));
    }

    fn leave_alternate(&mut self, restore: bool) {
        if self.tracker.alt_active {
            let (row, col) = self.cursor();
            // xterm.js clears the alternate buffer on leaving it, scroll region included;
            // `vt100` keeps the region on its alternate grid across switches.
            if self.tracker.regions[1].take().is_some() {
                self.send(b"\x1b[r");
            }
            self.send(if restore {
                b"\x1b[?1049l"
            } else {
                b"\x1b[?47l"
            });
            if !restore {
                self.flush();
                self.return_to((row, col));
            }
            let window = self.window();
            self.tracker.switch_screen(false, window);
        } else if restore {
            self.send(b"\x1b8");
        }
        if restore {
            self.restore_cursor();
            self.after_restore();
        }
    }

    pub(super) fn mode_query(&mut self, private: bool, mode: u16) {
        let state = if private {
            self.flush();
            let screen = self.parser.screen();
            match mode {
                1 => Some(screen.application_cursor()),
                25 => Some(!screen.hide_cursor()),
                47 | 1047 | 1049 => Some(screen.alternate_screen()),
                9 => Some(screen.mouse_protocol_mode() == MouseProtocolMode::Press),
                1000 => Some(screen.mouse_protocol_mode() == MouseProtocolMode::PressRelease),
                1002 => Some(screen.mouse_protocol_mode() == MouseProtocolMode::ButtonMotion),
                1003 => Some(screen.mouse_protocol_mode() == MouseProtocolMode::AnyMotion),
                1005 => Some(screen.mouse_protocol_encoding() == MouseProtocolEncoding::Utf8),
                1006 => Some(screen.mouse_protocol_encoding() == MouseProtocolEncoding::Sgr),
                2004 => Some(screen.bracketed_paste()),
                _ => self.tracker.private_mode(mode),
            }
        } else {
            (mode == 4).then_some(self.tracker.insert)
        };
        if let Some(set) = state {
            self.queries.push(DetectedQuery::ModeStatus {
                private,
                mode,
                state: if set {
                    ModeState::Set
                } else {
                    ModeState::Reset
                },
            });
        }
    }
}
