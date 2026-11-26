//! Character set state written into a fresh xterm.js after the snapshot's RIS. xterm.js's
//! `charsets` array only grows, and DECSC copies it at its current length (see
//! `tracker.charsets.rs`), so states are written in an order where that length never
//! exceeds the length being re-created; when no order can, the snapshot reports it.

use super::super::tracker::{Charset, Charsets};

const DESIGNATORS: [char; 4] = ['(', ')', '*', '+'];
const SHIFTS: [&str; 4] = ["\x0f", "\x0e", "\x1bn", "\x1bo"];

/// The length the restoring terminal's `charsets` array has reached, and whether every
/// state written so far was re-created exactly.
pub(super) struct CharsetWriter {
    len: u8,
    exact: bool,
}

impl CharsetWriter {
    pub(super) fn new() -> Self {
        Self {
            len: 0,
            exact: true,
        }
    }

    /// False when a written state's array length could not be re-created (a later cursor
    /// restore, or a save and restore, could then pick different sets than the original).
    pub(super) fn exact(&self) -> bool {
        self.exact
    }

    /// Designates and invokes `target`. Every set is ASCII and G0 invoked beforehand (the
    /// state after RIS or after [`Self::clear`]).
    pub(super) fn apply(&mut self, out: &mut String, target: Charsets) {
        self.exact &= self.len <= target.len();
        let sets = target.sets();
        for (index, (charset, designator)) in sets.iter().zip(DESIGNATORS).enumerate() {
            let last = index + 1 == usize::from(target.len());
            if *charset != Charset::Ascii || (last && self.len < target.len()) {
                out.push('\x1b');
                out.push(designator);
                out.push(charset.final_byte());
            }
        }
        self.len = self.len.max(target.len());
        if target.level() != 0 {
            out.push_str(SHIFTS.get(usize::from(target.level())).unwrap_or(&""));
        }
    }

    /// Back to ASCII in G0 invoked after [`Self::apply`] of `applied`, for the text that
    /// follows (the array keeps its length).
    pub(super) fn clear(&mut self, out: &mut String, applied: Charsets) {
        for (charset, designator) in applied.sets().iter().zip(DESIGNATORS) {
            if *charset != Charset::Ascii {
                out.push('\x1b');
                out.push(designator);
                out.push('B');
            }
        }
        if applied.level() != 0 {
            out.push('\x0f');
        }
    }
}
