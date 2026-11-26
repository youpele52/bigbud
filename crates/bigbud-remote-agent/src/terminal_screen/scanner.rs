//! Escape-sequence scanner that mirrors the `vte` 0.15 state machine `vt100` uses.
//!
//! The scanner tokenizes output so the model can (1) detect queries and side state that
//! `vt100` does not expose, (2) rewrite the few sequences `vt100` handles differently from
//! xterm.js, and (3) hold back every incomplete sequence. Because `vt100` only ever receives
//! complete sequences, its parser is in the ground state at every feed boundary, and the
//! held bytes are exactly the snapshot's pending escape tail.

use std::borrow::Cow;

#[path = "scanner.params.rs"]
mod params;
#[path = "scanner.step.rs"]
mod step;

pub(crate) use params::{MAX_PARAMS, Params};
use step::{State, Step};

/// Header limit for `pending_escape_tail` (§9.1): the most a held sequence may grow to.
pub(crate) const TAIL_CAP: usize = 16 * 1024;
/// OSC payload bytes kept for classification (OSC 8 targets, colour queries).
const OSC_COLLECT_CAP: usize = 4096;

/// Where a token's raw bytes live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Span {
    /// `bytes[start..end]` of the chunk being scanned.
    Chunk(usize, usize),
    /// Bytes carried over from earlier chunks; the model must flush its batch first.
    Held,
}

#[derive(Debug)]
pub(crate) enum Seq<'a> {
    Esc {
        intermediates: &'a [u8],
        final_byte: u8,
    },
    Csi {
        intermediates: &'a [u8],
        params: &'a Params,
        final_byte: u8,
    },
    Osc {
        payload: &'a [u8],
        truncated: bool,
    },
    /// DCS, SOS/PM/APC, an ignored CSI, or a sequence aborted by CAN, SUB or ESC.
    Other,
}

#[derive(Debug)]
pub(crate) enum Token<'a> {
    Text {
        raw: &'a [u8],
        span: Span,
    },
    /// SO (`shift_out = true`) or SI.
    Shift {
        shift_out: bool,
        span: Span,
    },
    Seq {
        seq: Seq<'a>,
        raw: &'a [u8],
        span: Span,
    },
    /// A control string longer than [`TAIL_CAP`]; it is never passed to `vt100`.
    Dropped {
        osc_payload: Option<&'a [u8]>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Esc,
    Csi,
    Osc,
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct Scanner {
    state: State,
    held: Vec<u8>,
    seq_len: usize,
    dropping: bool,
    params: Params,
    intermediates: [u8; 2],
    intermediate_len: usize,
    osc: Vec<u8>,
    osc_truncated: bool,
}

impl Default for Scanner {
    fn default() -> Self {
        Self {
            state: State::Ground,
            held: Vec::new(),
            seq_len: 0,
            dropping: false,
            params: Params::default(),
            intermediates: [0; 2],
            intermediate_len: 0,
            osc: Vec::new(),
            osc_truncated: false,
        }
    }
}

impl Scanner {
    /// Bytes a client must write after the snapshot ANSI to reach the same parser state.
    pub(crate) fn pending_tail(&self) -> Cow<'_, [u8]> {
        if !self.dropping {
            return Cow::Borrowed(&self.held);
        }
        // The real bytes were discarded; enter an equivalent state that ignores the rest.
        Cow::Borrowed(match self.state {
            State::OscString => b"\x1b]1337;",
            State::CsiEntry | State::CsiParam | State::CsiIntermediate | State::CsiIgnore => {
                b"\x1b[<"
            }
            State::Escape | State::EscapeIntermediate => b"\x1b(",
            _ => b"\x1b_",
        })
    }

    pub(crate) fn held_bytes(&self) -> usize {
        self.held.capacity() + self.osc.capacity()
    }

    pub(crate) fn scan<F: FnMut(Token<'_>)>(&mut self, bytes: &[u8], emit: &mut F) {
        let mut index = 0;
        let mut seq_start: Option<usize> = None;
        if self.state == State::Ground && !self.held.is_empty() {
            index = self.finish_partial_utf8(bytes, emit);
        }
        while index < bytes.len() {
            if self.state == State::Ground {
                let rest = bytes.get(index..).unwrap_or_default();
                let stop = rest
                    .iter()
                    .position(|b| matches!(b, 0x1b | 0x0e | 0x0f))
                    .map_or(bytes.len(), |offset| index + offset);
                if stop == bytes.len() {
                    let text = bytes.get(index..stop).unwrap_or_default();
                    let text_end = stop - partial_utf8_suffix(text);
                    if text_end > index {
                        emit_text(bytes, index, text_end, emit);
                    }
                    self.held
                        .extend_from_slice(bytes.get(text_end..stop).unwrap_or_default());
                    return;
                }
                if stop > index {
                    emit_text(bytes, index, stop, emit);
                }
                let byte = bytes.get(stop).copied().unwrap_or_default();
                index = stop + 1;
                if byte == 0x1b {
                    self.begin_escape();
                    seq_start = Some(stop);
                } else {
                    emit(Token::Shift {
                        shift_out: byte == 0x0e,
                        span: Span::Chunk(stop, stop + 1),
                    });
                }
                continue;
            }
            let byte = bytes.get(index).copied().unwrap_or_default();
            let step = self.step(byte);
            index += 1;
            match step {
                Step::Continue => {
                    self.seq_len += 1;
                    if !self.dropping && self.seq_len > TAIL_CAP {
                        self.dropping = true;
                        self.held.clear();
                    }
                }
                Step::Done(kind) => {
                    self.complete(kind, bytes, seq_start, index, emit);
                    seq_start = None;
                }
                Step::Restart(kind) => {
                    self.complete(kind, bytes, seq_start, index - 1, emit);
                    self.begin_escape();
                    seq_start = Some(index - 1);
                }
            }
        }
        if self.state != State::Ground && !self.dropping {
            let start = seq_start.unwrap_or(0);
            self.held
                .extend_from_slice(bytes.get(start..).unwrap_or_default());
        }
    }

    fn begin_escape(&mut self) {
        self.state = State::Escape;
        self.params.reset();
        self.intermediate_len = 0;
        self.osc.clear();
        self.osc_truncated = false;
        self.seq_len = 1;
        self.dropping = false;
    }

    fn collect(&mut self, byte: u8) {
        if let Some(slot) = self.intermediates.get_mut(self.intermediate_len) {
            *slot = byte;
            self.intermediate_len += 1;
        } else {
            self.params.ignoring = true;
        }
    }

    fn osc_put(&mut self, byte: u8) {
        if self.osc.len() < OSC_COLLECT_CAP {
            self.osc.push(byte);
        } else {
            self.osc_truncated = true;
        }
    }

    /// Emits the finished sequence ending at `bytes[..end]` and returns to ground.
    fn complete<F: FnMut(Token<'_>)>(
        &mut self,
        kind: Kind,
        bytes: &[u8],
        seq_start: Option<usize>,
        end: usize,
        emit: &mut F,
    ) {
        self.state = State::Ground;
        if self.dropping {
            self.dropping = false;
            self.held.clear();
            let osc_payload = (kind == Kind::Osc).then_some(self.osc.as_slice());
            emit(Token::Dropped { osc_payload });
            return;
        }
        let (raw_owned, span) = match seq_start {
            Some(start) => (None, Span::Chunk(start, end)),
            None => {
                self.held
                    .extend_from_slice(bytes.get(..end).unwrap_or_default());
                (Some(std::mem::take(&mut self.held)), Span::Held)
            }
        };
        let raw = match (&raw_owned, span) {
            (Some(held), _) => held.as_slice(),
            (None, Span::Chunk(start, end)) => bytes.get(start..end).unwrap_or_default(),
            (None, Span::Held) => &[],
        };
        let intermediates = self
            .intermediates
            .get(..self.intermediate_len)
            .unwrap_or_default();
        let seq = match kind {
            Kind::Esc => Seq::Esc {
                intermediates,
                final_byte: raw.last().copied().unwrap_or_default(),
            },
            Kind::Csi => Seq::Csi {
                intermediates,
                params: &self.params,
                final_byte: raw.last().copied().unwrap_or_default(),
            },
            Kind::Osc => Seq::Osc {
                payload: &self.osc,
                truncated: self.osc_truncated,
            },
            Kind::Other => Seq::Other,
        };
        emit(Token::Seq { seq, raw, span });
        if let Some(mut held) = raw_owned {
            held.clear();
            self.held = held;
        }
    }

    fn finish_partial_utf8<F: FnMut(Token<'_>)>(&mut self, bytes: &[u8], emit: &mut F) -> usize {
        let full = self.held.first().map_or(0, |lead| utf8_len(*lead));
        let missing = full.saturating_sub(self.held.len());
        let taken = bytes
            .iter()
            .take(missing)
            .take_while(|byte| **byte & 0xc0 == 0x80)
            .count();
        self.held
            .extend_from_slice(bytes.get(..taken).unwrap_or_default());
        if taken == bytes.len() && self.held.len() < full {
            return taken;
        }
        let held = std::mem::take(&mut self.held);
        emit(Token::Text {
            raw: &held,
            span: Span::Held,
        });
        self.held = held;
        self.held.clear();
        taken
    }
}

fn emit_text<F: FnMut(Token<'_>)>(bytes: &[u8], start: usize, end: usize, emit: &mut F) {
    emit(Token::Text {
        raw: bytes.get(start..end).unwrap_or_default(),
        span: Span::Chunk(start, end),
    });
}

pub(crate) fn utf8_len(lead: u8) -> usize {
    match lead {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    }
}

/// Length of an incomplete UTF-8 sequence at the end of `text` (0 when complete or invalid).
fn partial_utf8_suffix(text: &[u8]) -> usize {
    for back in 1..=text.len().min(3) {
        let Some(byte) = text.len().checked_sub(back).and_then(|at| text.get(at)) else {
            return 0;
        };
        if byte & 0xc0 == 0x80 {
            continue;
        }
        return if utf8_len(*byte) > back { back } else { 0 };
    }
    0
}
