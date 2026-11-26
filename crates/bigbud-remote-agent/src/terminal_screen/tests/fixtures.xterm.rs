//! Corpus, part 3: cursor and erase semantics checked against xterm.js `InputHandler.ts`
//! (pending wrap, IL/DL, IND/NEL, tab stops, BCE, SU/SD, DECSC state, wide-character wrap).
//! Each expectation is traced step by step in the comments.

use super::super::super::ExclusionKind;
use super::{Fixture, check, check_cell, check_text, feed};
use vt100::Color;

const NO_EXCLUSIONS: &[ExclusionKind] = &[];

pub(super) fn corpus() -> Vec<Fixture> {
    vec![
        Fixture {
            name: "pending_wrap_is_clamped_like_xterm",
            cols: 5,
            rows: 6,
            scrollback: 10,
            // BS from a pending wrap: clamp to col 4, then col 3 ("abcXe"). LF keeps col 4
            // ("    K"). TAB in a pending wrap is ignored, so "Q" wraps; the CR LF after it
            // scrolls one line. ECH clamps and erases the last column ("qrst"); CUU clamps.
            steps: vec![feed(
                "abcde\x08X\r\nfghij\nK\r\n\r\nlmnop\tQ\r\nqrstu\x1b[X\x1b[AZ",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                check(
                    dump.scrollback.first().map(|r| r.text()) == Some("abcXe".into()),
                    "BS",
                    out,
                );
                check_text(dump, 0, "fghij", out);
                check_text(dump, 1, "    K", out);
                check_text(dump, 2, "", out);
                check_text(dump, 3, "lmnop", out);
                check_text(dump, 4, "Q   Z", out);
                check_text(dump, 5, "qrst", out);
            },
        },
        Fixture {
            name: "insert_delete_lines_home_the_column",
            cols: 10,
            rows: 4,
            scrollback: 10,
            // IL at (1,2) then "X" at col 0; DL at (3,4) then "Y" at col 0; IND at the bottom
            // scrolls and keeps col 1 ("Z"); NEL from (0,3) goes to (1,0) ("W").
            steps: vec![feed(
                "one\r\ntwo\r\nthree\x1b[2;3H\x1b[LX\x1b[4;5H\x1b[MY\x1bDZ\x1b[1;4H\x1bEW",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                check_text(dump, 0, "X", out);
                check_text(dump, 1, "Wwo", out);
                check_text(dump, 2, "Y", out);
                check_text(dump, 3, " Z", out);
                check(dump.cursor == (1, 1), "cursor after NEL and W", out);
            },
        },
        Fixture {
            name: "custom_tab_stops",
            cols: 30,
            rows: 3,
            scrollback: 10,
            // Stops at cols 4 and 12; the third TAB has no stop left and goes to col 29.
            // CHT 2 reaches col 12, CBT 2 returns to col 4, and TBC 0 then clears col 4.
            steps: vec![feed(
                "\x1b[3g\x1b[5G\x1bH\x1b[13G\x1bH\r\ta\tb\tc\r\n\x1b[2Iq\x1b[2Zr\x1b[D\x1b[g",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, model, out| {
                check_text(dump, 0, "    a       b                c", out);
                check_cell(dump, (1, 12), |c| c.text == "q", "CHT 2", out);
                check_cell(dump, (1, 4), |c| c.text == "r", "CBT 2", out);
                check(
                    model.tracker.custom_tab_stops(0) == Some(vec![12]),
                    "TBC 0",
                    out,
                );
            },
        },
        Fixture {
            name: "scroll_up_discards_and_scroll_down_is_not_bce",
            cols: 8,
            rows: 4,
            scrollback: 10,
            // SU 3 discards a, b, c (no scrollback). SD with a red background exposes a
            // default line. DCH with red exposes a red cell at the right edge.
            steps: vec![feed(
                "a\r\nb\r\nc\r\nd\x1b[3S\x1b[41m\x1b[T\x1b[2;1H\x1b[P\x1b[m",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                check(
                    dump.scrollback.is_empty(),
                    "SU keeps nothing in scrollback",
                    out,
                );
                check_cell(
                    dump,
                    (0, 3),
                    |c| c.bg == Color::Default,
                    "SD line not BCE",
                    out,
                );
                check_text(dump, 1, "", out);
                check_cell(
                    dump,
                    (1, 7),
                    |c| c.bg == Color::Idx(1),
                    "DCH exposes red",
                    out,
                );
            },
        },
        Fixture {
            name: "background_colour_erase",
            cols: 8,
            rows: 4,
            scrollback: 10,
            // LF at the bottom with blue scrolls in a blue line ("E" on it); DL at row 2
            // exposes a green bottom line; ICH at (0,0) with magenta inserts two cells.
            steps: vec![feed(
                "a\r\nb\r\nc\r\nd\x1b[44m\nE\x1b[3;1H\x1b[42m\x1b[M\x1b[1;1H\x1b[45m\x1b[2@\x1b[m",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                check_text(dump, 0, "  b", out);
                check_cell(
                    dump,
                    (0, 1),
                    |c| c.bg == Color::Idx(5),
                    "ICH fills with bg",
                    out,
                );
                check_text(dump, 1, "c", out);
                check_cell(
                    dump,
                    (2, 1),
                    |c| c.text == "E",
                    "E on the scrolled-in line",
                    out,
                );
                check_cell(
                    dump,
                    (2, 5),
                    |c| c.bg == Color::Idx(4),
                    "LF scroll fills with bg",
                    out,
                );
                check_cell(
                    dump,
                    (3, 3),
                    |c| c.bg == Color::Idx(2),
                    "DL fills with bg",
                    out,
                );
            },
        },
        Fixture {
            name: "decsc_charsets_wide_wrap_and_alternate_fill",
            cols: 6,
            rows: 3,
            scrollback: 10,
            // DECRC restores G0 = DEC graphics (and the cursor), so the second "q" is "─".
            // A wide character at the last column ("f") wraps and blanks that column. The
            // alternate screen is entered with a blue background and filled with it.
            steps: vec![feed(
                "\x1b(0\x1b7\x1b(Bq\x1b8q\r\n\x1b(Babcdef\x1b[6G中\x1b(0\x1b[44m\x1b[?1049h",
            )],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, model, out| {
                let normal =
                    |row: usize| dump.visible.get(row).map(|r| r.text()).unwrap_or_default();
                check(normal(0) == "─", "DECRC restored G0", out);
                check(normal(1) == "abcde", "last column blanked", out);
                check(normal(2) == "中", "wide character wrapped", out);
                check_cell(
                    dump,
                    (0, 0),
                    |c| c.bg == Color::Idx(4),
                    "alternate filled with bg",
                    out,
                );
                check(
                    model.tracker.translation().is_some(),
                    "G0 is DEC graphics",
                    out,
                );
            },
        },
    ]
}
