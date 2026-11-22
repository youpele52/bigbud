//! Terminal state that `vt100` 0.18.1 does not model or does not expose, tracked from the
//! scanner's tokens in stream order: DEC/ANSI modes (origin, autowrap, insert, reverse wrap,
//! focus 1004, synchronized output 2026), scroll regions, kitty keyboard stacks, the G0–G3
//! character sets, the open OSC 8 hyperlink, attributes outside `vt100`, and exclusion marks.

use super::marks::{MarkKind, Marks, Window};
use super::probe::CellAttrs;

#[path = "tracker.charsets.rs"]
mod charsets;
#[path = "tracker.sgr.rs"]
mod sgr;
#[path = "tracker.tabs.rs"]
mod tabs;
pub(crate) use charsets::{Charset, Charsets};
pub(crate) use sgr::{extras_codes, plan_sgr};

/// Kitty keyboard stacks are bounded; the oldest entry is evicted when full.
const KITTY_STACK_CAP: usize = 32;
/// Longest OSC 8 `params;uri` kept for re-opening the link after a snapshot.
pub(crate) const LINK_CAP: usize = 4096;

/// What xterm.js DECSC saves, per screen (xterm.js keeps it on each buffer): attributes,
/// the character sets, origin and wraparound modes, plus the attributes tracked here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SavedState {
    pub(crate) attrs: CellAttrs,
    pub(crate) charsets: Charsets,
    pub(crate) origin: bool,
    pub(crate) autowrap: bool,
    unsupported: u8,
    intensity: (bool, bool),
    background: bool,
}

impl Default for SavedState {
    fn default() -> Self {
        Self {
            attrs: CellAttrs::default(),
            charsets: Charsets::default(),
            origin: false,
            autowrap: true,
            unsupported: 0,
            intensity: (false, false),
            background: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Tracker {
    pub(crate) alt_active: bool,
    /// Scroll regions (0-based, inclusive) for the normal and alternate screens.
    pub(crate) regions: [Option<(u16, u16)>; 2],
    pub(crate) origin: bool,
    pub(crate) autowrap: bool,
    pub(crate) insert: bool,
    pub(crate) reverse_wrap: bool,
    pub(crate) focus: bool,
    pub(crate) sync_output: bool,
    /// DECSCNM (`?5`): reverse video for the whole screen.
    pub(crate) reverse_video: bool,
    pub(crate) kitty: [Vec<u16>; 2],
    pub(crate) charsets: Charsets,
    /// `params;uri` of the open hyperlink; `None` when closed or too long to re-open.
    pub(crate) link: Option<Vec<u8>>,
    pub(crate) link_open: bool,
    /// Active attributes `vt100` cannot store (see `tracker.sgr.rs`).
    pub(crate) unsupported: u8,
    pub(crate) bold: bool,
    pub(crate) dim: bool,
    /// Hint that a background colour may be set (see `model.bce.rs`).
    pub(crate) background: bool,
    /// xterm.js's underline style is not `NONE` (see `tracker.sgr.rs`).
    pub(crate) underline_style: bool,
    /// DECSC state of the normal and alternate screens.
    saved: [SavedState; 2],
    /// Normal-screen scrollback length at the last DECSC there: xterm.js restores the row
    /// relative to its `ybase`, so lines scrolled into scrollback since move it up.
    pub(crate) saved_scrollback: usize,
    /// Per-screen tab stops once HTS or TBC changed them (see `tracker.tabs.rs`).
    pub(crate) tab_stops: [Option<Vec<bool>>; 2],
    pub(crate) marks: Marks,
    /// The model was rebuilt from a ring that did not start at a reset boundary.
    pub(crate) partial: bool,
    /// Normal-screen window top when the alternate screen was entered (it cannot be read
    /// from `vt100` while the alternate screen is active).
    pub(crate) normal_top_cache: u64,
    pub(crate) alt_allocated: bool,
    /// A wide character may have been printed since the last reset (see `model.text.rs`).
    pub(crate) wide_cells: bool,
}

impl Default for Tracker {
    fn default() -> Self {
        Self {
            alt_active: false,
            regions: [None; 2],
            origin: false,
            autowrap: true,
            insert: false,
            reverse_wrap: false,
            focus: false,
            sync_output: false,
            reverse_video: false,
            kitty: [Vec::new(), Vec::new()],
            charsets: Charsets::default(),
            link: None,
            link_open: false,
            unsupported: 0,
            bold: false,
            dim: false,
            background: false,
            underline_style: false,
            saved: [SavedState::default(); 2],
            saved_scrollback: 0,
            tab_stops: [None, None],
            marks: Marks::default(),
            partial: false,
            normal_top_cache: 0,
            alt_allocated: false,
            wide_cells: false,
        }
    }
}

impl Tracker {
    fn screen_index(&self) -> usize {
        usize::from(self.alt_active)
    }

    /// RIS: everything returns to power-on defaults, and the screen is fully determined
    /// (`vt100` builds a fresh screen, so the alternate rows are released too).
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// The character set that prints now, if it needs translation.
    pub(crate) fn translation(&self) -> Option<Charset> {
        let active = self.charsets.active();
        (active != Charset::Ascii).then_some(active)
    }

    /// DECSET/DECRST for modes outside `vt100`. Returns true when the mode is tracked here.
    pub(crate) fn set_private_mode(&mut self, mode: u16, enabled: bool) -> bool {
        match mode {
            // DECSET 2 designates ASCII into G0–G3 (DECRST 2 changes nothing in xterm.js).
            2 if enabled => self.charsets.designate_all_ascii(),
            2 => {}
            5 => self.reverse_video = enabled,
            6 => self.origin = enabled,
            7 => self.autowrap = enabled,
            45 => self.reverse_wrap = enabled,
            1004 => self.focus = enabled,
            2026 => self.sync_output = enabled,
            _ => return false,
        }
        true
    }

    pub(crate) fn private_mode(&self, mode: u16) -> Option<bool> {
        Some(match mode {
            5 => self.reverse_video,
            6 => self.origin,
            7 => self.autowrap,
            45 => self.reverse_wrap,
            1004 => self.focus,
            2026 => self.sync_output,
            _ => return None,
        })
    }

    /// DECSTBM as xterm.js applies it: the bottom defaults to and is clamped to the last row,
    /// and a region whose top is not above its bottom is ignored. Returns false when ignored
    /// (`vt100` would instead reset the region and home the cursor).
    pub(crate) fn set_region(&mut self, top: u16, bottom: u16, rows: u16) -> bool {
        let top = top.max(1) - 1;
        let bottom = if bottom == 0 || bottom > rows {
            rows
        } else {
            bottom
        } - 1;
        if top >= bottom {
            return false;
        }
        let region = (!(top == 0 && bottom + 1 == rows)).then_some((top, bottom));
        let index = self.screen_index();
        if let Some(slot) = self.regions.get_mut(index) {
            *slot = region;
        }
        true
    }

    pub(crate) fn region(&self) -> Option<(u16, u16)> {
        self.regions.get(self.screen_index()).copied().flatten()
    }

    /// Kitty keyboard protocol: `CSI > f u`, `CSI < n u`, `CSI = f ; m u`.
    pub(crate) fn kitty(&mut self, marker: u8, first: u16, second: u16) {
        let index = self.screen_index();
        let Some(stack) = self.kitty.get_mut(index) else {
            return;
        };
        match marker {
            b'>' => {
                if stack.len() == KITTY_STACK_CAP {
                    stack.remove(0);
                }
                stack.push(first);
            }
            b'<' => {
                let keep = stack.len().saturating_sub(usize::from(first.max(1)));
                stack.truncate(keep);
            }
            b'=' => {
                let current = stack.last().copied().unwrap_or(0);
                let next = match second {
                    2 => current | first,
                    3 => current & !first,
                    _ => first,
                };
                match stack.last_mut() {
                    Some(top) => *top = next,
                    None => stack.push(next),
                }
            }
            _ => {}
        }
    }

    pub(crate) fn kitty_in_use(&self) -> bool {
        self.kitty.iter().any(|stack| !stack.is_empty())
    }

    /// DECSC (and its aliases) on the active screen; `attrs` are `vt100`'s current ones.
    pub(crate) fn save_cursor(&mut self, attrs: CellAttrs) {
        let state = SavedState {
            attrs,
            charsets: self.charsets,
            origin: self.origin,
            autowrap: self.autowrap,
            unsupported: self.unsupported,
            intensity: (self.bold, self.dim),
            background: self.background,
        };
        let index = self.screen_index();
        if let Some(slot) = self.saved.get_mut(index) {
            *slot = state;
        }
    }

    /// DECRC on the active screen. Returns the attributes to apply and whether the
    /// unsupported set changed.
    pub(crate) fn restore_cursor(&mut self) -> (CellAttrs, bool) {
        let state = self.saved_state(self.screen_index());
        (self.bold, self.dim) = state.intensity;
        self.background = state.background;
        self.charsets.restore(state.charsets);
        (self.origin, self.autowrap) = (state.origin, state.autowrap);
        let before = self.unsupported != 0;
        // The underline style is not restored; the underline flag is.
        let stale = if self.underline_style == state.attrs.underline {
            0
        } else {
            sgr::STALE_UNDERLINE
        };
        self.unsupported =
            (state.unsupported & !sgr::STALE_UNDERLINE) | self.intensity_bit() | stale;
        (state.attrs, before != (self.unsupported != 0))
    }

    pub(crate) fn saved_state(&self, index: usize) -> SavedState {
        self.saved.get(index).copied().unwrap_or_default()
    }

    pub(crate) fn intensity_bit(&self) -> u8 {
        if self.bold && self.dim {
            sgr::BOLD_AND_DIM
        } else {
            0
        }
    }

    /// Switches screens, moving any active marks from the old screen to the new one.
    pub(crate) fn switch_screen(&mut self, alt: bool, normal_window: Option<Window>) {
        if alt == self.alt_active {
            return;
        }
        let active = self.active_marks();
        let (old, new) = if alt {
            (normal_window, None)
        } else {
            (None, normal_window)
        };
        for kind in &active {
            self.marks.deactivate(*kind, old);
        }
        self.alt_active = alt;
        if !alt {
            // xterm.js clears the alternate buffer on exit, tab stops included.
            self.tab_stops[1] = None;
        }
        if alt {
            self.alt_allocated = true;
            if let Some(window) = normal_window {
                self.normal_top_cache = window.top;
            }
            self.marks.clear_alt();
        }
        for kind in &active {
            self.marks.activate(*kind, new);
        }
    }

    /// Modes `vt100` does not implement and that change where output lands.
    pub(crate) fn unsupported_mode(&self) -> bool {
        !self.autowrap || self.insert || self.reverse_wrap
    }

    pub(crate) fn active_marks(&self) -> Vec<MarkKind> {
        let mut kinds = Vec::new();
        if self.unsupported_mode() {
            kinds.push(MarkKind::UnsupportedMode);
        }
        if self.link_open {
            kinds.push(MarkKind::Osc8Link);
        }
        if self.unsupported != 0 {
            kinds.push(MarkKind::UnsupportedAttribute);
        }
        kinds
    }

    /// ED 2 on the alternate screen erases everything marked there.
    pub(crate) fn alt_cleared(&mut self) {
        self.marks.clear_alt();
        for kind in self.active_marks() {
            self.marks.activate(kind, None);
        }
    }
}
