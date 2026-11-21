//! The bounded query responder (plan §8.9): the host answers terminal queries only while no
//! renderer is attached, and exactly one side answers each query.
//!
//! - Attached (the default, so a new PTY behaves as today): the view answers everything.
//! - Detached with `acked_sequence = A`: the host answers queries in output after `A`,
//!   including queries it already applied after `A` while attached (F8).
//! - Attaching through a snapshot with `attach_renderer`: queries detected while the fence is
//!   pending wait; once the snapshot's `through_sequence = C` is known, the host answers those
//!   at or before `C` and the view answers everything after it.

use std::collections::VecDeque;

use crate::pty;
use crate::terminal_screen::{DetectedQuery, ReplyContext, query_reply};

/// Where replies go: the PTY's input (in order with client input, outside its ledger).
pub(crate) trait ReplySink {
    fn write_reply(&self, bytes: &[u8]);
}

impl ReplySink for pty::PtyHandle {
    fn write_reply(&self, bytes: &[u8]) {
        if self.write_host_reply(bytes).is_err() {
            // The PTY is closing or its input queue is full; the query goes unanswered.
        }
    }
}

/// Recently detected queries kept for a detach that acknowledges an older sequence.
const RECENT_QUERIES: usize = 64;

#[derive(Clone, Copy, Debug)]
struct Seen {
    sequence: u64,
    query: DetectedQuery,
    answered: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Responder {
    /// The host answers queries in output after this sequence; `None` while attached.
    answer_after: Option<u64>,
    /// Snapshot attaches whose cut is not known yet.
    pending_attaches: usize,
    /// Queries detected while an attach is pending.
    pending: Vec<Seen>,
    recent: VecDeque<Seen>,
    context: ReplyContext,
    stopped: bool,
}

impl Responder {
    pub(crate) fn set_theme(&mut self, context: ReplyContext) {
        self.context = context;
    }

    /// The PTY closed or exited: no further replies.
    pub(crate) fn stop(&mut self) {
        self.stopped = true;
        self.pending.clear();
    }

    /// Queries the actor found in output chunk `sequence`, in stream order.
    pub(crate) fn observe(
        &mut self,
        handle: &dyn ReplySink,
        sequence: u64,
        queries: &[DetectedQuery],
    ) {
        for query in queries {
            let mut seen = Seen {
                sequence,
                query: *query,
                answered: false,
            };
            if self.pending_attaches > 0 {
                if self.pending.len() < RECENT_QUERIES {
                    self.pending.push(seen);
                }
            } else if self.host_answers(sequence) {
                self.reply(handle, query);
                seen.answered = true;
            }
            self.remember(seen);
        }
    }

    fn host_answers(&self, sequence: u64) -> bool {
        !self.stopped && self.answer_after.is_some_and(|after| sequence > after)
    }

    fn remember(&mut self, seen: Seen) {
        if self.recent.len() == RECENT_QUERIES {
            self.recent.pop_front();
        }
        self.recent.push_back(seen);
    }

    /// Answers one query the host is responsible for. Unanswerable queries (clipboard, title,
    /// a colour without a pushed theme) stay silent, as today; replies are best effort, like a
    /// renderer's, and never count as client input.
    fn reply(&self, handle: &dyn ReplySink, query: &DetectedQuery) {
        if let Some(bytes) = query_reply(query, &self.context) {
            handle.write_reply(&bytes);
        }
    }

    /// The renderer detached after parsing output through `acked`.
    pub(crate) fn detach(&mut self, handle: &dyn ReplySink, acked: u64) {
        self.answer_after = Some(acked);
        for index in 0..self.recent.len() {
            let Some(seen) = self.recent.get(index).copied() else {
                break;
            };
            if !seen.answered && self.host_answers(seen.sequence) {
                self.reply(handle, &seen.query);
                if let Some(entry) = self.recent.get_mut(index) {
                    entry.answered = true;
                }
            }
        }
    }

    /// A renderer attached without a snapshot cut (a live view state push).
    pub(crate) fn attach(&mut self) {
        self.answer_after = None;
    }

    /// A snapshot with `attach_renderer` is about to fence the model.
    pub(crate) fn begin_attach(&mut self) {
        self.pending_attaches += 1;
    }

    /// The fence produced `cut` (the snapshot's `through_sequence`), or failed with `None`.
    pub(crate) fn finish_attach(&mut self, handle: &dyn ReplySink, cut: Option<u64>) {
        self.pending_attaches = self.pending_attaches.saturating_sub(1);
        let pending = std::mem::take(&mut self.pending);
        for seen in pending {
            let mine = cut.is_none_or(|cut| seen.sequence <= cut);
            if mine && self.host_answers(seen.sequence) {
                self.reply(handle, &seen.query);
                if let Some(entry) = self
                    .recent
                    .iter_mut()
                    .rev()
                    .find(|entry| entry.sequence == seen.sequence && entry.query == seen.query)
                {
                    entry.answered = true;
                }
            }
        }
        if cut.is_some() {
            self.answer_after = None;
        }
    }
}

/// Parses a pushed theme colour: `#rgb`, `#rrggbb` or xterm's `rgb:r/g/b` (1-4 hex digits per
/// channel). Anything else means "do not answer" for that colour.
pub(crate) fn parse_color(value: &str) -> Option<[u8; 3]> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let digits = hex.as_bytes();
        let nibble = |byte: u8| char::from(byte).to_digit(16).map(|digit| digit as u8);
        return match digits.len() {
            3 => {
                let mut out = [0u8; 3];
                for (slot, byte) in out.iter_mut().zip(digits) {
                    *slot = nibble(*byte)? * 17;
                }
                Some(out)
            }
            6 => {
                let mut out = [0u8; 3];
                for (slot, pair) in out.iter_mut().zip(digits.chunks(2)) {
                    let [high, low] = pair else { return None };
                    *slot = nibble(*high)? * 16 + nibble(*low)?;
                }
                Some(out)
            }
            _ => None,
        };
    }
    let channels = value.strip_prefix("rgb:")?;
    let mut out = [0u8; 3];
    let mut parts = channels.split('/');
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 4 {
            return None;
        }
        let raw = u32::from_str_radix(part, 16).ok()?;
        let max = (1u32 << (4 * part.len() as u32)) - 1;
        *slot = u8::try_from(raw * 255 / max).ok()?;
    }
    parts.next().is_none().then_some(out)
}

#[cfg(test)]
#[path = "pty_lifecycle.responder.tests.rs"]
mod tests;
