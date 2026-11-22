//! Cursor, attributes and modes written after the screen contents.

use super::super::probe::{CellAttrs, Probe, SavedCursor, WrapCell, wrap_cell};
use super::super::tracker::{SavedState, Tracker, extras_codes};
use super::charsets::CharsetWriter;
use super::rows::set_attrs;
use std::fmt::Write as _;
use vt100::{CursorStyle, MouseProtocolEncoding, MouseProtocolMode};

/// State of the active screen, read before any probing changes it.
pub(super) struct ActiveState {
    cursor: (u16, u16),
    attrs: CellAttrs,
    hide_cursor: bool,
    cursor_style: CursorStyle,
    application_cursor: bool,
    application_keypad: bool,
    bracketed_paste: bool,
    mouse_mode: MouseProtocolMode,
    mouse_encoding: MouseProtocolEncoding,
    /// The cursor is past the last column (pending wrap): the cell to print again there.
    wrap_cell: Option<WrapCell>,
}

impl ActiveState {
    pub(super) fn read(probe: &Probe) -> Self {
        let screen = probe.screen();
        let cursor = screen.cursor_position();
        let wrap_cell = wrap_cell(screen, cursor.0, cursor.1);
        Self {
            cursor,
            attrs: CellAttrs::of_screen(screen),
            hide_cursor: screen.hide_cursor(),
            cursor_style: screen.cursor_style(),
            application_cursor: screen.application_cursor(),
            application_keypad: screen.application_keypad(),
            bracketed_paste: screen.bracketed_paste(),
            mouse_mode: screen.mouse_protocol_mode(),
            mouse_encoding: screen.mouse_protocol_encoding(),
            wrap_cell,
        }
    }
}

/// Positions (re-printing the last cell for a pending wrap), sets the attributes and the
/// character sets and wraparound mode DECSC also saves in xterm.js, saves, then resets them.
pub(super) fn write_saved(
    out: &mut String,
    saved: &SavedCursor,
    modes: SavedState,
    charsets: &mut CharsetWriter,
) {
    let mut current = CellAttrs::default();
    out.push_str("\x1b[m");
    move_to(
        out,
        &mut current,
        u32::from(saved.row) + 1,
        saved.col,
        saved.wrap_cell.as_ref(),
    );
    set_attrs(out, &mut current, modes.attrs);
    charsets.apply(out, modes.charsets);
    if !modes.autowrap {
        out.push_str("\x1b[?7l");
    }
    out.push_str("\x1b7\x1b[m");
    charsets.clear(out, modes.charsets);
    if !modes.autowrap {
        out.push_str("\x1b[?7h");
    }
}

/// Moves to `row` (1-based) and column `col` (0-based); a pending wrap prints its cell.
fn move_to(out: &mut String, current: &mut CellAttrs, row: u32, col: u16, wrap: Option<&WrapCell>) {
    match wrap {
        Some(cell) => {
            let _ = write!(out, "\x1b[{row};{}H", u32::from(cell.col) + 1);
            set_attrs(out, current, cell.attrs);
            out.push_str(&cell.contents);
        }
        None => {
            let _ = write!(out, "\x1b[{row};{}H", u32::from(col) + 1);
        }
    }
}

/// Whether an alternate screen's saved cursor differs from a fresh xterm.js buffer's.
pub(super) fn needs_saved(saved: &SavedCursor, modes: SavedState) -> bool {
    (saved.row, saved.col) != (0, 0) || modes != SavedState::default()
}

/// State kept on the inactive alternate screen (its saved cursor, when [`needs_saved`], and
/// kitty stack), written by switching to it and back; the final cursor position is written
/// afterwards.
pub(super) fn write_inactive_alternate(
    out: &mut String,
    saved: Option<&SavedCursor>,
    modes: SavedState,
    kitty: Option<&Vec<u16>>,
    charsets: &mut CharsetWriter,
) {
    let kitty = kitty.filter(|stack| !stack.is_empty());
    if saved.is_none() && kitty.is_none() {
        return;
    }
    out.push_str("\x1b[?47h");
    if let Some(saved) = saved {
        write_saved(out, saved, modes, charsets);
    }
    write_kitty(out, kitty);
    out.push_str("\x1b[?47l");
}

pub(super) fn write_kitty(out: &mut String, stack: Option<&Vec<u16>>) {
    for flags in stack.into_iter().flatten() {
        let _ = write!(out, "\x1b[>{flags}u");
    }
}

/// Custom tab stops of screen `index`, written while that screen is active.
pub(super) fn write_tab_stops(out: &mut String, tracker: &Tracker, index: usize) {
    if let Some(stops) = tracker.custom_tab_stops(index) {
        out.push_str("\x1b[3g");
        for col in stops {
            let _ = write!(out, "\x1b[{}G\x1bH", u32::from(col) + 1);
        }
    }
}

pub(super) fn write_active(
    out: &mut String,
    active: &ActiveState,
    tracker: &Tracker,
    cols: u16,
    charsets: &mut CharsetWriter,
) {
    write_tab_stops(out, tracker, usize::from(tracker.alt_active));
    let region = tracker.region();
    if let Some((top, bottom)) = region {
        let _ = write!(out, "\x1b[{};{}r", top + 1, bottom + 1);
    }
    let top = match (tracker.origin, region) {
        (true, Some((top, _))) => top,
        _ => 0,
    };
    if tracker.origin {
        out.push_str("\x1b[?6h");
    }
    let row = u32::from(active.cursor.0.saturating_sub(top)) + 1;
    let mut current = CellAttrs::default();
    out.push_str("\x1b[m");
    let col = active.cursor.1.min(cols - 1);
    move_to(out, &mut current, row, col, active.wrap_cell.as_ref());
    if current != active.attrs {
        out.push_str("\x1b[m");
        current = CellAttrs::default();
        set_attrs(out, &mut current, active.attrs);
    }
    // Attributes `vt100` cannot store but xterm.js applies to the text that follows.
    let extras = extras_codes(tracker.unsupported, active.attrs.bold);
    if !extras.is_empty() {
        let _ = write!(out, "\x1b[{}m", extras.join(";"));
    }
    // Always explicit: xterm.js RIS does not reset cursor visibility.
    out.push_str(if active.hide_cursor {
        "\x1b[?25l"
    } else {
        "\x1b[?25h"
    });
    if let Some(style) = cursor_style_code(active.cursor_style) {
        let _ = write!(out, "\x1b[{style} q");
    }
    write_input_modes(out, active, tracker);
    charsets.apply(out, tracker.charsets);
}

/// DECSCUSR parameter for a non-default cursor style.
pub(crate) fn cursor_style_code(style: CursorStyle) -> Option<u8> {
    match style {
        CursorStyle::Default => None,
        CursorStyle::BlinkBlock => Some(1),
        CursorStyle::SteadyBlock => Some(2),
        CursorStyle::BlinkUnderline => Some(3),
        CursorStyle::SteadyUnderline => Some(4),
        CursorStyle::BlinkVerticalBar => Some(5),
        CursorStyle::SteadyVerticalBar => Some(6),
    }
}

fn write_input_modes(out: &mut String, active: &ActiveState, tracker: &Tracker) {
    let mouse_mode = match active.mouse_mode {
        MouseProtocolMode::None => None,
        MouseProtocolMode::Press => Some(9),
        MouseProtocolMode::PressRelease => Some(1000),
        MouseProtocolMode::ButtonMotion => Some(1002),
        MouseProtocolMode::AnyMotion => Some(1003),
    };
    let mouse_encoding = match active.mouse_encoding {
        MouseProtocolEncoding::Default => None,
        MouseProtocolEncoding::Utf8 => Some(1005),
        MouseProtocolEncoding::Sgr => Some(1006),
    };
    for (on, sequence) in [
        (active.application_cursor, "\x1b[?1h"),
        (active.application_keypad, "\x1b="),
        (active.bracketed_paste, "\x1b[?2004h"),
        (tracker.focus, "\x1b[?1004h"),
        (tracker.insert, "\x1b[4h"),
        (!tracker.autowrap, "\x1b[?7l"),
        (tracker.reverse_wrap, "\x1b[?45h"),
        (tracker.sync_output, "\x1b[?2026h"),
        (tracker.reverse_video, "\x1b[?5h"),
    ] {
        if on {
            out.push_str(sequence);
        }
    }
    for mode in [mouse_mode, mouse_encoding].into_iter().flatten() {
        let _ = write!(out, "\x1b[?{mode}h");
    }
    if let Some(link) = tracker
        .link
        .as_deref()
        .and_then(|link| std::str::from_utf8(link).ok())
    {
        let _ = write!(out, "\x1b]8;{link}\x1b\\");
    }
}
