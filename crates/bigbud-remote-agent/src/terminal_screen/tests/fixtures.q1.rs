//! Corpus, part 4: regressions minimised from the Q1 randomized streams (character sets as
//! xterm.js designates, shifts, saves and restores them; empty cells left by wide characters;
//! the alternate screen's saved cursor; the underline style DECRC does not restore). Each
//! expectation is traced against xterm.js `InputHandler.ts` in the comments.

use super::super::super::ExclusionKind;
use super::{Fixture, check, check_text, feed};

const NO_EXCLUSIONS: &[ExclusionKind] = &[];
const ATTRIBUTES: &[ExclusionKind] = &[ExclusionKind::UnsupportedAttributes];

pub(super) fn corpus() -> Vec<Fixture> {
    vec![
        Fixture {
            name: "decrc_restores_only_saved_designations",
            cols: 10,
            rows: 3,
            scrollback: 10,
            // DECSC copies an empty set array, so DECRC restores no set: G0 and G1 keep DEC
            // graphics ("─" through G0, then through G1).
            steps: vec![feed("\x1b7\x1b(0\x1b)0\x1b8q\x0eq\x0f\x1b(B")],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, model, out| {
                check_text(dump, 0, "──", out);
                check(
                    model.tracker.translation().is_none(),
                    "G0 back to ASCII",
                    out,
                );
            },
        },
        Fixture {
            name: "leaving_1049_restores_only_saved_designations",
            cols: 10,
            rows: 3,
            scrollback: 10,
            // Row 0: `?1049h` saves no set, so G0 designated on the alternate screen survives
            // `?1049l`. Row 1: `?1049h` saves G0 only; G1 designated on the alternate screen
            // survives.
            steps: vec![feed(concat!(
                "\x1b[?1049h\x1b(0\x1b[?1049lq\x1b(B\r\n",
                "\x1b[?1049h\x1b)0\x1b[?1049l\x0eq\x0f",
            ))],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, model, out| {
                check_text(dump, 0, "─", out);
                check_text(dump, 1, "─", out);
                check(model.tracker.translation().is_none(), "G0 is ASCII", out);
            },
        },
        Fixture {
            name: "national_charsets_and_locking_shifts",
            cols: 12,
            rows: 3,
            scrollback: 10,
            // British `#`, German `[\]`, Dutch `[` (first unit of "ij") and `|`. Then G2 DEC
            // via LS2, G3 British via LS3, LS1R back to G1 (ASCII); an unregistered final is
            // ignored (G0 stays DEC); `ESC % G` and DECSET 2 return G0 to ASCII.
            steps: vec![feed(concat!(
                "\x1b(A#\x1b(K[\\]\x1b(4[|\x1b(B#\r\n",
                "\x1b*0\x1bnq\x1b+A\x1bo#\x1b~q\x0f\x1b(0\x1b(Xq\x1b%Gq\x1b(0\x1b[?2hq",
            ))],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, model, out| {
                check_text(dump, 0, "£ÄÖÜif#", out);
                check_text(dump, 1, "─£q─qq", out);
                check(
                    model.tracker.translation().is_none(),
                    "ASCII at the end",
                    out,
                );
            },
        },
        Fixture {
            name: "shorter_saved_designations_are_written_first",
            cols: 10,
            rows: 3,
            scrollback: 10,
            // The alternate screen saves an empty set array (and a cursor at row 2, col 3);
            // the normal screen saves one designation. xterm.js's array only grows, so the
            // snapshot must write the alternate copy before the normal one.
            steps: vec![feed("\x1b[?47h\x1b[2;3H\x1b7\x1b[?47l\x1b(0\x1b7\x1b(Bok")],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                // `?47l` carries the cursor back from the alternate screen.
                check_text(dump, 1, "  ok", out);
            },
        },
        Fixture {
            name: "underlined_wide_wrap_and_orphaned_half",
            cols: 5,
            rows: 3,
            scrollback: 10,
            // An underlined wide character wraps from the last column: xterm.js leaves an empty
            // underlined cell there, which no snapshot can re-create (reported). Overwriting
            // the first half of an underlined emoji leaves the same kind of cell.
            steps: vec![feed("abcd\x1b[4m中\r\n\x1b[24mab\x1b[4m😀\x1b[3;3Ho")],
            exclusions: ATTRIBUTES,
            expect: |dump, _, out| {
                check_text(dump, 1, "中", out);
                check_text(dump, 2, "abo", out);
            },
        },
        Fixture {
            name: "alternate_saved_cursor_survives_1049",
            cols: 14,
            rows: 4,
            scrollback: 10,
            // xterm.js keeps the alternate buffer's DECSC state across `?1049l`/`?1049h`; SCORC
            // on the second visit restores (0, 6).
            steps: vec![feed("360646\x1b[?1049h\x1b7\x1b[?1049l\x1b[?1049h\x1b[u")],
            exclusions: NO_EXCLUSIONS,
            expect: |dump, _, out| {
                check(dump.cursor == (0, 6), "alternate saved cursor kept", out);
            },
        },
        Fixture {
            name: "decrc_keeps_the_underline_style",
            cols: 10,
            rows: 3,
            scrollback: 10,
            // DECRC restores the underline flag (off) but not the double underline style;
            // closing an OSC 8 link re-enables it in xterm.js, so "ab" is underlined there
            // (reported: the snapshot writes it without an underline). SGR 0 ends it.
            steps: vec![feed("\x1b[21m\x1b8\x1b]8;;\x07ab\x1b[m")],
            exclusions: ATTRIBUTES,
            expect: |dump, _, out| {
                check_text(dump, 0, "ab", out);
            },
        },
    ]
}
