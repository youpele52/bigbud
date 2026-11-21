//! Snapshot serializer (§8.4, §15 R1). Output order: reset, normal scrollback and screen,
//! the normal screen's saved cursor and region, the alternate screen, the active region,
//! cursor and SGR, then input modes. The pending escape tail is returned separately and is
//! written last by the client (`PtyScreenSnapshotHeader.pending_escape_tail`).

use super::copy::ScreenCopy;
use super::fidelity::{Exclusion, ExclusionKind, FidelityReport};
use super::marks::{MarkKind, Marks};
use super::probe::{Probe, SavedCursor};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

#[path = "serialize.rows.rs"]
pub(crate) mod rows;
#[path = "serialize.state.rs"]
mod state;

use rows::{utf16_units, write_row};
pub(crate) use state::cursor_style_code;

/// The web contract's `TERMINAL_RECOVERY_ANSI_MAX_CHARS`.
pub const MAX_ANSI_UTF16_UNITS: usize = 1_048_576;
pub const MAX_ANSI_UTF8_BYTES: usize = 3 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotLimits {
    pub max_utf16_units: usize,
    pub max_utf8_bytes: usize,
    pub max_scrollback_rows: usize,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        Self {
            max_utf16_units: MAX_ANSI_UTF16_UNITS,
            max_utf8_bytes: MAX_ANSI_UTF8_BYTES,
            max_scrollback_rows: usize::MAX,
        }
    }
}

impl SnapshotLimits {
    /// Request values clamped to the protocol caps; zero means "use the cap".
    pub fn from_request(
        max_ansi_units: u32,
        max_utf8_bytes: u32,
        max_scrollback_rows: u32,
    ) -> Self {
        let clamp = |requested: u32, cap: usize| match usize::try_from(requested) {
            Ok(0) | Err(_) => cap,
            Ok(value) => value.min(cap),
        };
        Self {
            max_utf16_units: clamp(max_ansi_units, MAX_ANSI_UTF16_UNITS),
            max_utf8_bytes: clamp(max_utf8_bytes, MAX_ANSI_UTF8_BYTES),
            max_scrollback_rows: clamp(max_scrollback_rows, usize::MAX),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SnapshotError {
    #[error("the visible screen alone needs {bytes} bytes / {units} UTF-16 units, over the limits")]
    VisibleExceedsLimits { bytes: usize, units: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenSnapshot {
    pub through_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    /// Scrollback rows included in `ansi`.
    pub scrollback_rows: u32,
    pub alternate_screen: bool,
    pub fidelity: FidelityReport,
    pub ansi: String,
    pub utf16_units: usize,
    /// Written by the client after `ansi`, before live output after `through_sequence`.
    pub pending_escape_tail: Vec<u8>,
    /// Marks re-expressed for a model restored from this snapshot (checkpoints).
    pub(crate) restored_marks: Marks,
}

impl ScreenSnapshot {
    /// SHA-256 of `ansi`, as carried in `PtyScreenSnapshotHeader.sha256`.
    pub fn sha256(&self) -> [u8; 32] {
        Sha256::digest(self.ansi.as_bytes()).into()
    }
}

/// One serialized scrollback row (with its line separator) and its UTF-16 length.
struct Line {
    end: usize,
    units: usize,
}

pub(crate) fn serialize(
    copy: ScreenCopy,
    limits: &SnapshotLimits,
) -> Result<ScreenSnapshot, SnapshotError> {
    let ScreenCopy {
        screen,
        tracker,
        pending_tail,
        discarded,
        through_sequence,
        ..
    } = copy;
    let mut probe = Probe::new(screen);
    let (rows, cols) = (probe.rows(), probe.cols());
    let alternate = probe.screen().alternate_screen();
    let active = state::ActiveState::read(&probe);

    // The alternate screen is read first: probing the normal screen leaves it.
    let mut alt_block = String::new();
    let mut alt_saved: Option<SavedCursor> = None;
    if alternate {
        let mut after_wrap = false;
        let mut first = true;
        probe.visit_visible(|row| {
            if !first {
                alt_block.push_str(if after_wrap { "" } else { "\r\n" });
            }
            first = false;
            write_row(&mut alt_block, row, cols, after_wrap);
            after_wrap = row.wrapped();
        });
        alt_saved = Some(probe.saved_cursor());
        probe.leave_alternate();
    }

    let scrollback = probe.scrollback_len();
    let skip = scrollback.saturating_sub(limits.max_scrollback_rows);
    let total_lines = scrollback - skip + usize::from(rows);
    let mut body = String::new();
    let mut lines: Vec<Line> = Vec::with_capacity(scrollback - skip);
    let mut line_index = 0usize;
    let mut after_wrap = false;
    probe.visit_rows(skip, |row| {
        let start = body.len();
        write_row(&mut body, row, cols, after_wrap);
        after_wrap = row.wrapped();
        line_index += 1;
        if line_index < total_lines && !after_wrap {
            body.push_str("\r\n");
        }
        if line_index <= scrollback - skip {
            let units = utf16_units(body.get(start..).unwrap_or_default());
            lines.push(Line {
                end: body.len(),
                units,
            });
        }
    });
    let normal_saved = shift_saved(
        probe.saved_cursor(),
        scrollback,
        tracker.saved_scrollback,
        rows,
        cols,
    );
    let (normal_state, alt_state) = (tracker.saved_state(0), tracker.saved_state(1));
    // `vt100` keeps the inactive alternate screen's saved cursor across sessions.
    let inactive_saved =
        (!alternate && tracker.alt_allocated).then(|| probe.inactive_alternate_saved());

    let prefix = "\x1bc";
    let mut suffix = String::new();
    state::write_saved(&mut suffix, &normal_saved, normal_state);
    if alternate {
        if let Some((top, bottom)) = tracker.regions.first().copied().flatten() {
            let _ = write!(suffix, "\x1b[{};{}r", top + 1, bottom + 1);
        }
        state::write_kitty(&mut suffix, tracker.kitty.first());
        state::write_tab_stops(&mut suffix, &tracker, 0);
        suffix.push_str("\x1b[?47h\x1b[H");
        suffix.push_str(&alt_block);
        if let Some(saved) = &alt_saved {
            state::write_saved(&mut suffix, saved, alt_state);
        }
        state::write_kitty(&mut suffix, tracker.kitty.get(1));
    } else {
        state::write_kitty(&mut suffix, tracker.kitty.first());
        state::write_inactive_alternate(
            &mut suffix,
            inactive_saved.as_ref(),
            alt_state,
            tracker.kitty.get(1),
        );
    }
    state::write_active(&mut suffix, &active, &tracker, cols);

    // Drop the oldest scrollback rows until both caps hold; never the visible rows.
    let fixed_bytes = prefix.len() + suffix.len();
    let fixed_units = utf16_units(prefix) + utf16_units(&suffix);
    let total_units: usize = fixed_units + utf16_units(&body);
    let mut dropped = 0usize;
    let mut dropped_bytes = 0usize;
    let mut dropped_units = 0usize;
    while fixed_bytes + body.len() - dropped_bytes > limits.max_utf8_bytes
        || total_units - dropped_units > limits.max_utf16_units
    {
        let Some(line) = lines.get(dropped) else {
            return Err(SnapshotError::VisibleExceedsLimits {
                bytes: fixed_bytes + body.len() - dropped_bytes,
                units: total_units - dropped_units,
            });
        };
        dropped_units += line.units;
        dropped_bytes = line.end;
        dropped += 1;
    }
    let mut ansi = String::with_capacity(fixed_bytes + body.len() - dropped_bytes);
    ansi.push_str(prefix);
    ansi.push_str(body.get(dropped_bytes..).unwrap_or_default());
    ansi.push_str(&suffix);

    let emitted_scrollback = scrollback - skip - dropped;
    let normal_top = discarded + u64::try_from(scrollback).unwrap_or(u64::MAX);
    let first_emitted = normal_top - u64::try_from(emitted_scrollback).unwrap_or(0);
    let emitted = Some((first_emitted, normal_top + u64::from(rows) - 1));
    let alt_rows = if alternate { rows } else { 0 };
    let fidelity = fidelity_report(&tracker.marks, &tracker, emitted, alt_rows, dropped);
    Ok(ScreenSnapshot {
        through_sequence,
        cols,
        rows,
        scrollback_rows: u32::try_from(emitted_scrollback).unwrap_or(u32::MAX),
        alternate_screen: alternate,
        fidelity,
        utf16_units: total_units - dropped_units,
        ansi,
        pending_escape_tail: pending_tail,
        restored_marks: tracker.marks.rebase(first_emitted),
    })
}

fn fidelity_report(
    marks: &Marks,
    tracker: &super::tracker::Tracker,
    emitted: Option<(u64, u64)>,
    alt_rows: u16,
    dropped: usize,
) -> FidelityReport {
    let mut exclusions = Vec::new();
    for (kind, rows) in [
        (
            ExclusionKind::ReflowAfterWidthChange,
            marks.reflow_rows(emitted, alt_rows),
        ),
        (
            ExclusionKind::Osc8LinkTargets,
            marks.count(MarkKind::Osc8Link, emitted, alt_rows),
        ),
        (
            ExclusionKind::UnsupportedAttributes,
            marks.count(MarkKind::UnsupportedAttribute, emitted, alt_rows),
        ),
        (
            ExclusionKind::UnsupportedModes,
            marks.count(MarkKind::UnsupportedMode, emitted, alt_rows),
        ),
    ] {
        if rows > 0 {
            exclusions.push(Exclusion { kind, rows });
        }
    }
    if tracker.kitty_in_use() {
        exclusions.push(Exclusion {
            kind: ExclusionKind::KittyKeyboardHostOnly,
            rows: 0,
        });
    }
    let trimmed = u32::try_from(dropped).unwrap_or(u32::MAX);
    FidelityReport::new(tracker.partial, trimmed, exclusions)
}

/// xterm.js restores the normal screen's saved row relative to `ybase`: lines scrolled into
/// scrollback since DECSC move it up (and DECRC clamps the column). The snapshot saves the
/// position that restore would produce now, at the client's current `ybase`.
fn shift_saved(
    saved: SavedCursor,
    scrollback: usize,
    at_save: usize,
    rows: u16,
    cols: u16,
) -> SavedCursor {
    let shift =
        i64::try_from(scrollback).unwrap_or(i64::MAX) - i64::try_from(at_save).unwrap_or(i64::MAX);
    if shift == 0 {
        return saved;
    }
    let row = (i64::from(saved.row) - shift).clamp(0, i64::from(rows) - 1);
    SavedCursor {
        row: u16::try_from(row).unwrap_or(0),
        col: saved.col.min(cols - 1),
        wrap_cell: None,
        ..saved
    }
}
