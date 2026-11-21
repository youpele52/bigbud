//! `ScreenModel`: the host-side terminal screen (R1). `vt100` owns the grid; the scanner and
//! tracker add what xterm.js shows but `vt100` 0.18.1 does not model (see `mod.rs`).

use super::copy::ScreenCopy;
use super::query::{self, DetectedQuery, ReplyContext};
use super::scanner::Scanner;
use super::serialize::{ScreenSnapshot, SnapshotError, SnapshotLimits};
use super::tracker::Tracker;
use std::num::NonZeroU16;

#[path = "model.bce.rs"]
mod bce;
#[path = "model.cursor.rs"]
mod cursor;
#[path = "model.feed.rs"]
mod feed;
#[path = "model.modes.rs"]
mod modes;
#[path = "model.text.rs"]
mod text;

/// Scrollback rows kept by default (§8.4).
pub const DEFAULT_SCROLLBACK_ROWS: usize = 1_000;
/// Upper bound accepted from `PtyCreateRequest.screen_scrollback_rows`.
pub const MAX_SCROLLBACK_ROWS: usize = 10_000;
/// `size_of::<vt100::Cell>()` (asserted by `vt100` itself) plus a share of each row's header.
const CELL_BYTES: usize = 32;
const ROW_OVERHEAD_BYTES: usize = 40;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScreenError {
    #[error("terminal geometry must be at least 1x1 (got {cols}x{rows})")]
    InvalidGeometry { cols: u16, rows: u16 },
    #[error("screen scrollback of {0} rows exceeds the {MAX_SCROLLBACK_ROWS}-row limit")]
    ScrollbackTooLarge(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenGeometry {
    pub cols: u16,
    pub rows: u16,
}

/// Queries found in one feed, in stream order, with the state their replies depend on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedOutput {
    pub queries: Vec<DetectedQuery>,
}

/// Counts normal-screen rows discarded from the top of scrollback, for absolute row numbers.
#[derive(Clone, Debug, Default)]
pub(crate) struct ScrollCounter {
    pub(crate) discarded: u64,
}

impl vt100::Callbacks for ScrollCounter {
    fn on_scroll(&mut self, _contents: vt100::capture::RowContents<'_>, alternate: bool) {
        if !alternate {
            self.discarded = self.discarded.saturating_add(1);
        }
    }
}

pub struct ScreenModel {
    pub(crate) parser: vt100::Parser<ScrollCounter>,
    pub(crate) scanner: Scanner,
    pub(crate) tracker: Tracker,
    scrollback_rows: usize,
    scratch: Vec<u8>,
}

fn non_zero(cols: u16, rows: u16) -> Result<(NonZeroU16, NonZeroU16), ScreenError> {
    match (NonZeroU16::new(cols), NonZeroU16::new(rows)) {
        (Some(cols), Some(rows)) => Ok((cols, rows)),
        _ => Err(ScreenError::InvalidGeometry { cols, rows }),
    }
}

impl ScreenModel {
    pub fn new(cols: u16, rows: u16, scrollback_rows: usize) -> Result<Self, ScreenError> {
        let (cols_nz, rows_nz) = non_zero(cols, rows)?;
        if scrollback_rows > MAX_SCROLLBACK_ROWS {
            return Err(ScreenError::ScrollbackTooLarge(scrollback_rows));
        }
        Ok(Self {
            parser: vt100::Parser::new_with_callbacks(
                rows_nz,
                cols_nz,
                scrollback_rows,
                ScrollCounter::default(),
            ),
            scanner: Scanner::default(),
            tracker: Tracker::default(),
            scrollback_rows,
            scratch: Vec::new(),
        })
    }

    pub fn geometry(&self) -> ScreenGeometry {
        let (rows, cols) = self.parser.screen().size();
        ScreenGeometry {
            cols: cols.get(),
            rows: rows.get(),
        }
    }

    pub fn scrollback_capacity(&self) -> usize {
        self.scrollback_rows
    }

    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// Applies PTY output and returns the queries it contains. Never blocks or allocates per
    /// byte; incomplete sequences are held (at most 16 KiB) until the next feed.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedOutput {
        feed::feed(self, bytes)
    }

    /// Resizes like xterm.js/`vt100`: scroll regions reset; a width change marks every
    /// existing row as written before it (`vt100` truncates, xterm.js reflows).
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), ScreenError> {
        let (cols_nz, rows_nz) = non_zero(cols, rows)?;
        let before = self.geometry();
        if before == (ScreenGeometry { cols, rows }) {
            return Ok(());
        }
        self.parser.set_size(rows_nz, cols_nz);
        self.tracker.regions = [None; 2];
        self.tracker.resize_tab_stops(cols);
        if before.cols != cols {
            let alt = self.alternate_screen();
            let boundary = if alt {
                // The normal screen is inactive; bound its top from above (see `Marks`).
                self.tracker.normal_top_cache + u64::from(before.rows.max(rows))
            } else {
                feed::normal_window(self).map_or(0, |window| window.top + u64::from(rows))
            };
            self.tracker.marks.width_changed(alt, boundary);
        }
        Ok(())
    }

    /// The immutable copy taken at a snapshot fence (F1). Serializing it never touches `self`.
    pub fn copy(&self, through_sequence: u64) -> ScreenCopy {
        ScreenCopy {
            screen: self.parser.screen().clone(),
            tracker: self.tracker.clone(),
            pending_tail: self.scanner.pending_tail().into_owned(),
            discarded: self.parser.callbacks().discarded,
            through_sequence,
            estimated_bytes: self.estimated_bytes(),
        }
    }

    /// Copies and serializes in one step (tests, checkpoints, and callers without an actor).
    pub fn snapshot(&self, limits: &SnapshotLimits) -> Result<ScreenSnapshot, SnapshotError> {
        self.copy(0).serialize(limits)
    }

    /// Marks the model as rebuilt from output that did not start at a reset boundary.
    pub fn mark_partial(&mut self) {
        self.tracker.partial = true;
    }

    pub fn is_partial(&self) -> bool {
        self.tracker.partial
    }

    /// Approximate heap use: every allocated row (normal scrollback and screen, plus the
    /// alternate screen once used) at `vt100`'s 32-byte cells, plus held bytes.
    pub fn estimated_bytes(&self) -> usize {
        let geometry = self.geometry();
        let screen = self.parser.screen();
        let scrollback = if screen.alternate_screen() {
            usize::try_from(
                self.tracker
                    .normal_top_cache
                    .saturating_sub(self.parser.callbacks().discarded),
            )
            .unwrap_or(self.scrollback_rows)
            .min(self.scrollback_rows)
        } else {
            screen.scrollback_len()
        };
        let alt_rows = if self.tracker.alt_allocated {
            usize::from(geometry.rows)
        } else {
            0
        };
        let rows = scrollback + usize::from(geometry.rows) + alt_rows;
        let row_bytes = usize::from(geometry.cols) * CELL_BYTES + ROW_OVERHEAD_BYTES;
        rows * row_bytes + self.scanner.held_bytes() + self.scratch.capacity()
    }

    pub fn query_reply(&self, query: &DetectedQuery, context: &ReplyContext) -> Option<Vec<u8>> {
        query::reply(query, context)
    }
}
