//! Reads `vt100` state that its public API only exposes indirectly. The probe owns the copied
//! screen and mutates it freely: `ESC 8` reveals the saved cursor and attributes, `CSI ?47l`
//! reveals the normal screen while the alternate screen is active, and scrollback rows are
//! read through `set_scrollback` windows.

use std::num::NonZeroU16;
use vt100::{Cell, Color, Screen};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CellAttrs {
    pub(crate) fg: Color,
    pub(crate) bg: Color,
    pub(crate) bold: bool,
    pub(crate) dim: bool,
    pub(crate) italic: bool,
    pub(crate) underline: bool,
    pub(crate) inverse: bool,
}

impl CellAttrs {
    pub(crate) fn of_cell(cell: &Cell) -> Self {
        Self {
            fg: cell.fgcolor(),
            bg: cell.bgcolor(),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        }
    }

    pub(crate) fn of_screen(screen: &Screen) -> Self {
        Self {
            fg: screen.fgcolor(),
            bg: screen.bgcolor(),
            bold: screen.bold(),
            dim: screen.dim(),
            italic: screen.italic(),
            underline: screen.underline(),
            inverse: screen.inverse(),
        }
    }

    /// xterm.js erases with the background colour only.
    pub(crate) fn blank(bg: Color) -> Self {
        Self {
            bg,
            ..Self::default()
        }
    }
}

/// One visible row of the probed screen (scrollback rows are scrolled into view first).
#[derive(Clone, Copy)]
pub(crate) struct RowRef<'a> {
    screen: &'a Screen,
    row: u16,
}

impl<'a> RowRef<'a> {
    pub(crate) fn cell(&self, col: u16) -> Option<&'a Cell> {
        self.screen.cell(self.row, col)
    }

    pub(crate) fn wrapped(&self) -> bool {
        self.screen.row_wrapped(self.row)
    }
}

/// The saved cursor (`DECSC`) of the active screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SavedCursor {
    pub(crate) row: u16,
    pub(crate) col: u16,
    pub(crate) attrs: CellAttrs,
    pub(crate) wrap_cell: Option<WrapCell>,
}

/// The cell to print again so the client cursor ends past the last column (pending wrap).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WrapCell {
    pub(crate) col: u16,
    pub(crate) contents: String,
    pub(crate) attrs: CellAttrs,
}

/// `vt100` reports a pending wrap as a cursor column equal to the width.
pub(crate) fn wrap_cell(screen: &Screen, row: u16, col: u16) -> Option<WrapCell> {
    let cols = screen.size().1.get();
    if col < cols {
        return None;
    }
    let last = cols - 1;
    let continuation = screen
        .cell(row, last)
        .is_some_and(Cell::is_wide_continuation);
    let col = if continuation && last > 0 {
        last - 1
    } else {
        last
    };
    let (contents, attrs) = match screen.cell(row, col) {
        Some(cell) if cell.has_contents() => (cell.contents().to_owned(), CellAttrs::of_cell(cell)),
        Some(cell) => (" ".to_owned(), CellAttrs::blank(cell.bgcolor())),
        None => (" ".to_owned(), CellAttrs::default()),
    };
    Some(WrapCell {
        col,
        contents,
        attrs,
    })
}

pub(crate) struct Probe {
    parser: vt100::Parser,
}

const ONE: NonZeroU16 = NonZeroU16::MIN;

impl Probe {
    pub(crate) fn new(screen: Screen) -> Self {
        let mut parser = vt100::Parser::new(ONE, ONE, 0);
        *parser.screen_mut() = screen;
        Self { parser }
    }

    pub(crate) fn screen(&self) -> &Screen {
        self.parser.screen()
    }

    pub(crate) fn rows(&self) -> u16 {
        self.screen().size().0.get()
    }

    pub(crate) fn cols(&self) -> u16 {
        self.screen().size().1.get()
    }

    /// Restores the saved cursor and reads it. Changes the cursor and attributes.
    pub(crate) fn saved_cursor(&mut self) -> SavedCursor {
        self.parser.process(b"\x1b8");
        let (row, col) = self.screen().cursor_position();
        SavedCursor {
            row,
            col,
            attrs: CellAttrs::of_screen(self.screen()),
            wrap_cell: wrap_cell(self.screen(), row, col),
        }
    }

    /// From the normal screen, enters the alternate screen without clearing it and reads its
    /// saved cursor. Changes the active screen, cursor and attributes.
    pub(crate) fn inactive_alternate_saved(&mut self) -> SavedCursor {
        self.parser.process(b"\x1b[?47h");
        self.saved_cursor()
    }

    /// Makes the normal screen active (without touching its contents or cursor).
    pub(crate) fn leave_alternate(&mut self) {
        self.parser.process(b"\x1b[?47l");
    }

    pub(crate) fn scrollback_len(&self) -> usize {
        self.screen().scrollback_len()
    }

    /// Visits scrollback rows from index `skip` (0 = oldest), then every visible row.
    pub(crate) fn visit_rows(&mut self, skip: usize, mut visit: impl FnMut(RowRef<'_>)) {
        let rows = usize::from(self.rows());
        let scrollback = self.scrollback_len();
        let mut index = skip;
        while index < scrollback {
            let offset = scrollback - index;
            self.parser.screen_mut().set_scrollback(offset);
            let take = rows.min(offset);
            let screen = self.parser.screen();
            for row in 0..take {
                visit(RowRef {
                    screen,
                    row: u16::try_from(row).unwrap_or(u16::MAX),
                });
            }
            index += take;
        }
        self.parser.screen_mut().set_scrollback(0);
        self.visit_visible(visit);
    }

    pub(crate) fn visit_visible(&self, mut visit: impl FnMut(RowRef<'_>)) {
        let screen = self.parser.screen();
        for row in 0..self.rows() {
            visit(RowRef { screen, row });
        }
    }
}
