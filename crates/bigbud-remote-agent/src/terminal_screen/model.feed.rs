//! The feed path: scanner tokens are batched into contiguous `vt100::Parser::process` calls,
//! except for the few sequences that need a query capture, a rewrite, or a mark transition.

use super::super::marks::{MarkKind, Window};
use super::super::query::{self, DetectedQuery};
use super::super::scanner::{Params, Seq, Span, Token};
use super::super::tracker::{Charsets, LINK_CAP, plan_sgr};
use super::{FeedOutput, ScreenModel, ScrollCounter};

pub(super) fn feed(model: &mut ScreenModel, bytes: &[u8]) -> FeedOutput {
    let ScreenModel {
        parser,
        scanner,
        tracker,
        scratch,
        ..
    } = model;
    let mut feeder = Feeder {
        parser,
        tracker,
        scratch,
        bytes,
        batch: None,
        queries: Vec::new(),
        restored_attrs: None,
    };
    scanner.scan(bytes, &mut |token| feeder.token(token));
    feeder.flush();
    FeedOutput {
        queries: feeder.queries,
    }
}

/// The normal screen's visible window, or `None` while the alternate screen is active.
pub(super) fn normal_window(model: &ScreenModel) -> Option<Window> {
    window_of(&model.parser)
}

fn window_of(parser: &vt100::Parser<ScrollCounter>) -> Option<Window> {
    let screen = parser.screen();
    if screen.alternate_screen() {
        return None;
    }
    let scrollback = u64::try_from(screen.scrollback_len()).unwrap_or(u64::MAX);
    Some(Window {
        top: parser.callbacks().discarded.saturating_add(scrollback),
        rows: screen.size().0.get(),
    })
}

pub(super) struct Feeder<'a, 'b> {
    pub(super) parser: &'a mut vt100::Parser<ScrollCounter>,
    pub(super) tracker: &'a mut super::Tracker,
    pub(super) scratch: &'a mut Vec<u8>,
    bytes: &'b [u8],
    batch: Option<(usize, usize)>,
    pub(super) queries: Vec<DetectedQuery>,
    /// Attributes DECRC restores on the active screen, applied in `after_restore`.
    pub(super) restored_attrs: Option<super::super::probe::CellAttrs>,
}

impl Feeder<'_, '_> {
    pub(super) fn flush(&mut self) {
        if let Some((start, end)) = self.batch.take() {
            self.parser
                .process(self.bytes.get(start..end).unwrap_or_default());
        }
    }

    /// Forwards a token's original bytes, extending the batch when they are contiguous.
    pub(super) fn pass(&mut self, span: Span, raw: &[u8]) {
        match (span, self.batch) {
            (Span::Chunk(start, end), Some((batch_start, batch_end))) if batch_end == start => {
                self.batch = Some((batch_start, end));
            }
            (Span::Chunk(start, end), _) => {
                self.flush();
                self.batch = Some((start, end));
            }
            (Span::Held, _) => {
                self.flush();
                self.parser.process(raw);
            }
        }
    }

    /// Sends replacement bytes in place of a token's original bytes.
    pub(super) fn send(&mut self, bytes: &[u8]) {
        self.flush();
        self.parser.process(bytes);
    }

    /// The current normal window; flushes first so it reflects every earlier byte.
    pub(super) fn window(&mut self) -> Option<Window> {
        self.flush();
        let window = window_of(self.parser);
        if let Some(window) = window {
            let oldest = self.parser.callbacks().discarded;
            self.tracker.marks.prune(oldest);
            self.tracker.normal_top_cache = window.top;
        }
        window
    }

    pub(super) fn cursor(&mut self) -> (u16, u16) {
        self.flush();
        self.parser.screen().cursor_position()
    }

    /// Records an activation or deactivation of `kind` at the current point in the stream.
    pub(super) fn mark(&mut self, kind: MarkKind, active: bool) {
        let window = self.window();
        if active {
            self.tracker.marks.activate(kind, window);
        } else {
            self.tracker.marks.deactivate(kind, window);
        }
    }

    fn token(&mut self, token: Token<'_>) {
        match token {
            Token::Text { raw, span } => {
                self.report_wide_overwrites(raw);
                self.text_token(raw, span);
            }
            Token::Shift { shift_out, span } => {
                self.tracker.charsets.invoke(u8::from(shift_out));
                self.pass(span, &[]);
            }
            Token::Dropped { osc_payload } => {
                self.flush();
                if let Some(payload) = osc_payload {
                    self.osc(payload, true);
                }
            }
            Token::Seq { seq, raw, span } => match seq {
                Seq::Esc {
                    intermediates,
                    final_byte,
                } => self.esc(intermediates, final_byte, raw, span),
                Seq::Csi {
                    intermediates,
                    params,
                    final_byte,
                } => self.csi(intermediates, params, final_byte, raw, span),
                Seq::Osc { payload, truncated } => {
                    self.osc(payload, truncated);
                    self.pass(span, raw);
                }
                Seq::Other => self.pass(span, raw),
            },
        }
    }

    fn esc(&mut self, intermediates: &[u8], final_byte: u8, raw: &[u8], span: Span) {
        match (intermediates, final_byte) {
            ([], b'c') => {
                self.flush();
                // xterm.js RIS keeps cursor visibility and style (`isCursorHidden` and the
                // cursor options are not reset); `vt100` builds a fresh screen.
                let hidden = self.parser.screen().hide_cursor();
                let style = self.parser.screen().cursor_style();
                self.pass(span, raw);
                self.flush();
                self.parser.callbacks_mut().discarded = 0;
                self.tracker.reset();
                if hidden {
                    self.parser.process(b"\x1b[?25l");
                }
                if let Some(code) = super::super::serialize::cursor_style_code(style) {
                    self.parser.process(format!("\x1b[{code} q").as_bytes());
                }
            }
            ([], b'7') => {
                self.save_cursor();
                self.pass(span, raw);
            }
            ([], b'8') => {
                self.restore_cursor();
                self.pass(span, raw);
                self.after_restore();
            }
            // IND and NEL: `vt100` implements neither; they are LF and CR LF (LNM is off).
            ([], b'D' | b'E') => {
                let replacement: &[u8] = if final_byte == b'D' { b"\n" } else { b"\r\n" };
                if self.tracker.background {
                    self.flush();
                    self.text_with_background(replacement);
                } else {
                    self.text(replacement, Span::Held);
                }
            }
            ([], b'M') => {
                self.restrict_cursor();
                if self.tracker.background {
                    self.index_with_background(raw, span);
                } else {
                    self.pass(span, raw);
                }
            }
            // HTS: `vt100` has no tab stop state of its own.
            ([], b'H') => {
                self.flush();
                let screen = self.parser.screen();
                let (col, cols) = (screen.cursor_position().1, screen.size().1.get());
                if col < cols {
                    self.tracker.set_tab_stop(col, cols);
                }
            }
            _ => {
                // Character set designations and shifts; `vt100` ignores them.
                self.tracker.charsets.escape(intermediates, final_byte);
                self.pass(span, raw);
            }
        }
    }

    fn csi(
        &mut self,
        intermediates: &[u8],
        params: &Params,
        final_byte: u8,
        raw: &[u8],
        span: Span,
    ) {
        let (private, rest) = match intermediates.split_first() {
            Some((marker @ 0x3c..=0x3f, rest)) => (Some(*marker), rest),
            _ => (None, intermediates),
        };
        let single = params.group_count() <= 1 && params.all_zero();
        let plain = private.is_none() && rest.is_empty();
        if plain && b"ABCDEFd@PXLM".contains(&final_byte) {
            self.restrict_cursor();
        }
        let row_before = self.parser.screen().cursor_position().0;
        match (private, rest, final_byte) {
            (None, [], b'm') => self.sgr(params, raw, span),
            (Some(b'?'), [], b'h' | b'l') => {
                self.private_modes(params, final_byte == b'h', raw, span)
            }
            (None, [], b'h' | b'l') => {
                if params.groups().any(|group| group.first() == Some(&4)) {
                    let before = self.tracker.unsupported_mode();
                    self.tracker.insert = final_byte == b'h';
                    self.sync_mode_mark(before);
                }
                self.pass(span, raw);
            }
            (None, [], b'r') => {
                let mut groups = params.groups().map(|g| g.first().copied().unwrap_or(0));
                let (top, bottom) = (groups.next().unwrap_or(0), groups.next().unwrap_or(0));
                let rows = self.parser.screen().size().0.get();
                if self.tracker.set_region(top, bottom, rows) {
                    self.pass(span, raw);
                    // `vt100` homes to the region's top row; xterm.js homes to the origin
                    // (the region's top only in origin mode, which `CSI H` reproduces).
                    self.send(b"\x1b[H");
                }
            }
            // SCOSC/SCORC: xterm.js saves and restores the cursor; `vt100` ignores them.
            (None, [], b's') if single => {
                self.save_cursor();
                self.send(b"\x1b7");
            }
            (None, [], b'u') if single => {
                self.restore_cursor();
                self.send(b"\x1b8");
                self.after_restore();
            }
            (Some(marker @ (b'>' | b'<' | b'=')), [], b'u') => {
                let mut groups = params.groups().map(|g| g.first().copied().unwrap_or(0));
                let (first, second) = (groups.next().unwrap_or(0), groups.next().unwrap_or(0));
                self.tracker.kitty(marker, first, second);
                self.pass(span, raw);
            }
            (None, [], b'c') if params.all_zero() => {
                self.queries.push(DetectedQuery::PrimaryDeviceAttributes);
                self.pass(span, raw);
            }
            (None, [], b'n') if params.group_count() == 1 => {
                self.pass(span, raw);
                match params.first() {
                    5 => self.queries.push(DetectedQuery::DeviceStatus),
                    6 => {
                        let (row, col) = self.cursor();
                        self.queries.push(DetectedQuery::CursorPosition {
                            row: row.saturating_add(1),
                            col: col.saturating_add(1),
                        });
                    }
                    _ => {}
                }
            }
            (Some(b'?') | None, [b'$'], b'p') => {
                self.pass(span, raw);
                self.mode_query(private.is_some(), params.first());
            }
            (None, [], b'S' | b'L' | b'M' | b'@' | b'P')
                if final_byte == b'S' || self.tracker.background =>
            {
                self.shift(final_byte, params.first(), raw, span);
            }
            (None, [], b'g') => {
                self.flush();
                let screen = self.parser.screen();
                let (col, cols) = (screen.cursor_position().1, screen.size().1.get());
                self.tracker.clear_tab_stops(params.first(), col, cols);
            }
            (None, [], b'I') => {
                let _handled = self.tab(params.first().max(1));
            }
            (None, [], b'Z') => self.back_tab(params.first().max(1)),
            // DECSTR resets the character sets (not the copy DECSC saved).
            (None, [b'!'], b'p') => {
                self.tracker.charsets = Charsets::default();
                self.pass(span, raw);
            }
            (None, [], b'J') if params.first() == 2 && self.tracker.alt_active => {
                self.tracker.alt_cleared();
                self.pass(span, raw);
            }
            _ => self.pass(span, raw),
        }
        if plain && matches!(final_byte, b'L' | b'M') {
            // xterm.js moves to the first column when IL/DL apply (inside the margins).
            let (top, bottom) = self.tracker.region().unwrap_or((0, u16::MAX));
            if (top..=bottom).contains(&row_before) {
                self.send(b"\r");
            }
        }
    }

    fn sgr(&mut self, params: &Params, raw: &[u8], span: Span) {
        let plan = plan_sgr(params, self.tracker);
        let was_active = self.tracker.unsupported != 0;
        let now_active = plan.unsupported != 0;
        if was_active != now_active {
            self.mark(MarkKind::UnsupportedAttribute, now_active);
        }
        self.tracker.unsupported = plan.unsupported;
        self.tracker.bold = plan.bold;
        self.tracker.dim = plan.dim;
        self.tracker.background = plan.background;
        self.tracker.underline_style = plan.underline_style;
        match plan.rewrite {
            None => self.pass(span, raw),
            Some(bytes) if bytes.is_empty() => self.flush(),
            Some(bytes) => self.send(&bytes),
        }
    }

    fn osc(&mut self, payload: &[u8], truncated: bool) {
        let Some(link) = payload.strip_prefix(b"8;") else {
            query::color_queries(payload, &mut self.queries);
            return;
        };
        let uri = link
            .iter()
            .position(|byte| *byte == b';')
            .and_then(|at| link.get(at + 1..))
            .unwrap_or_default();
        let open = !uri.is_empty();
        if open != self.tracker.link_open {
            self.mark(MarkKind::Osc8Link, open);
        }
        self.tracker.link_open = open;
        self.tracker.link = (open && !truncated && link.len() <= LINK_CAP).then(|| link.to_vec());
    }
}
