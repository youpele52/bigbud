//! Synthetic fidelity corpus (§15 R1 fixtures). Each fixture lists its input steps, the
//! exclusions it is expected to report, and assertions written from xterm.js semantics.

use super::super::{ExclusionKind, ScreenModel};
use super::dump::{Dump, DumpCell};
use vt100::Color;

#[path = "fixtures.more.rs"]
mod more;
#[path = "fixtures.xterm.rs"]
mod xterm;

#[derive(Clone, Debug)]
pub(crate) enum Step {
    Feed(Vec<u8>),
    Resize(u16, u16),
}

pub(crate) type Expect = fn(&Dump, &ScreenModel, &mut Vec<String>);

pub(crate) struct Fixture {
    pub(crate) name: &'static str,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) scrollback: usize,
    pub(crate) steps: Vec<Step>,
    pub(crate) exclusions: &'static [ExclusionKind],
    pub(crate) expect: Expect,
}

pub(crate) fn feed(text: &str) -> Step {
    Step::Feed(text.as_bytes().to_vec())
}

impl Fixture {
    pub(crate) fn run(&self) -> ScreenModel {
        let mut model = ScreenModel::new(self.cols, self.rows, self.scrollback).expect("model");
        for step in &self.steps {
            match step {
                Step::Feed(bytes) => {
                    let _ = model.feed(bytes);
                }
                Step::Resize(cols, rows) => model.resize(*cols, *rows).expect("resize"),
            }
        }
        model
    }

    /// Same steps, but every feed is split into single bytes.
    pub(crate) fn run_bytewise(&self) -> ScreenModel {
        let mut model = ScreenModel::new(self.cols, self.rows, self.scrollback).expect("model");
        for step in &self.steps {
            match step {
                Step::Feed(bytes) => {
                    for byte in bytes {
                        let _ = model.feed(std::slice::from_ref(byte));
                    }
                }
                Step::Resize(cols, rows) => model.resize(*cols, *rows).expect("resize"),
            }
        }
        model
    }
}

pub(crate) fn check_text(dump: &Dump, row: usize, expected: &str, out: &mut Vec<String>) {
    let actual = dump.line(row);
    if actual != expected {
        out.push(format!("row {row}: {actual:?} != {expected:?}"));
    }
}

pub(crate) fn check_cell(
    dump: &Dump,
    (row, col): (usize, usize),
    check: impl Fn(&DumpCell) -> bool,
    what: &str,
    out: &mut Vec<String>,
) {
    match dump.cell(row, col) {
        Some(cell) if check(cell) => {}
        other => out.push(format!("cell ({row},{col}) {what}: {other:?}")),
    }
}

pub(crate) fn check(condition: bool, what: &str, out: &mut Vec<String>) {
    if !condition {
        out.push(what.to_owned());
    }
}

const BOLD: u8 = 1;
const DIM: u8 = 2;
const ITALIC: u8 = 4;
const UNDERLINE: u8 = 8;
const INVERSE: u8 = 16;

pub(crate) fn corpus() -> Vec<Fixture> {
    let mut fixtures = vec![
        Fixture {
            name: "sgr_16_256_truecolor",
            cols: 40,
            rows: 6,
            scrollback: 100,
            steps: vec![feed(concat!(
                "\x1b[31mred\x1b[0m \x1b[91mbright\x1b[0m\r\n",
                "\x1b[38;5;208m256\x1b[48;5;21mbg\x1b[0m\r\n",
                "\x1b[38;2;10;20;30mtrue\x1b[48;2;200;100;50mcolor\x1b[0m\r\n",
                "\x1b[1mbold\x1b[22m \x1b[2mdim\x1b[22m \x1b[3mital\x1b[23m \x1b[4mund\x1b[24m \x1b[7minv\x1b[27m\r\n",
                "\x1b[38:2::1:2:3mcolon\x1b[m \x1b[4:3mcurly\x1b[4:0m\x1b[38:5:9mx\x1b[m",
            ))],
            exclusions: &[ExclusionKind::UnsupportedAttributes],
            expect: |dump, _, out| {
                check_cell(
                    dump,
                    (0, 0),
                    |c| c.text == "r" && c.fg == Color::Idx(1),
                    "red",
                    out,
                );
                check_cell(dump, (0, 4), |c| c.fg == Color::Idx(9), "bright", out);
                check_cell(dump, (1, 0), |c| c.fg == Color::Idx(208), "256 fg", out);
                check_cell(
                    dump,
                    (1, 3),
                    |c| c.bg == Color::Idx(21) && c.fg == Color::Idx(208),
                    "256 bg",
                    out,
                );
                check_cell(
                    dump,
                    (2, 0),
                    |c| c.fg == Color::Rgb(10, 20, 30),
                    "truecolor",
                    out,
                );
                check_cell(
                    dump,
                    (2, 4),
                    |c| c.bg == Color::Rgb(200, 100, 50),
                    "truecolor bg",
                    out,
                );
                check_cell(dump, (3, 0), |c| c.flags == BOLD, "bold", out);
                check_cell(dump, (3, 5), |c| c.flags == DIM, "dim", out);
                check_cell(dump, (3, 9), |c| c.flags == ITALIC, "italic", out);
                check_cell(dump, (3, 14), |c| c.flags == UNDERLINE, "underline", out);
                check_cell(dump, (3, 18), |c| c.flags == INVERSE, "inverse", out);
                check_cell(
                    dump,
                    (4, 0),
                    |c| c.fg == Color::Rgb(1, 2, 3),
                    "colon truecolor",
                    out,
                );
                check_cell(
                    dump,
                    (4, 6),
                    |c| c.flags == UNDERLINE,
                    "curly as underline",
                    out,
                );
                check_cell(
                    dump,
                    (4, 11),
                    |c| c.fg == Color::Idx(9) && c.flags == 0,
                    "4:0 resets",
                    out,
                );
            },
        },
        Fixture {
            name: "wide_cjk_emoji_combining",
            cols: 11,
            rows: 5,
            scrollback: 100,
            steps: vec![feed("中文字\r\n😀x\r\ne\u{301}a\r\n1234567890中")],
            exclusions: &[],
            expect: |dump, _, out| {
                check_cell(
                    dump,
                    (0, 0),
                    |c| c.text == "中" && c.width == 2,
                    "wide",
                    out,
                );
                check_cell(dump, (0, 1), |c| c.width == 0, "continuation", out);
                check_cell(dump, (0, 2), |c| c.text == "文", "second wide", out);
                check_cell(
                    dump,
                    (1, 0),
                    |c| c.text == "😀" && c.width == 2,
                    "emoji",
                    out,
                );
                check_cell(dump, (1, 2), |c| c.text == "x", "after emoji", out);
                check_cell(dump, (2, 0), |c| c.text == "e\u{301}", "combining", out);
                check_cell(dump, (2, 1), |c| c.text == "a", "after combining", out);
                check_text(dump, 3, "1234567890", out);
                check_cell(
                    dump,
                    (4, 0),
                    |c| c.text == "中",
                    "wide wrapped to next row",
                    out,
                );
            },
        },
        Fixture {
            name: "scroll_region_and_index",
            cols: 20,
            rows: 6,
            scrollback: 100,
            steps: vec![feed(concat!(
                "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6",
                "\x1b[2;5rH",
                "\x1b[5;1H\n\nX\x1b[2;1H\x1bMY",
            ))],
            exclusions: &[],
            expect: |dump, model, out| {
                check_text(dump, 0, "Hine1", out);
                check_text(dump, 1, "Y", out);
                check_text(dump, 2, "line4", out);
                check_text(dump, 3, "line5", out);
                check_text(dump, 4, "", out);
                check_text(dump, 5, "line6", out);
                check(
                    model.tracker.region() == Some((1, 4)),
                    "region 2;5 tracked",
                    out,
                );
            },
        },
        Fixture {
            name: "decsc_decrc_and_scosc",
            cols: 20,
            rows: 4,
            scrollback: 100,
            steps: vec![feed(concat!(
                "abc\x1b7\x1b[31m\x1b[3;5Hmid\x1b8def",
                "\x1b[2;1Hab\x1b[s\x1b[4;4Hx\x1b[uy",
                "\x1b[2;8H\x1b[32m\x1b7\x1b[m\x1b[4;10Hend",
            ))],
            exclusions: &[],
            expect: |dump, _, out| {
                check_text(dump, 0, "abcdef", out);
                check_cell(
                    dump,
                    (0, 3),
                    |c| c.fg == Color::Default,
                    "DECRC restores attributes",
                    out,
                );
                check_text(dump, 1, "aby", out);
                check_text(dump, 2, "    mid", out);
                check(dump.saved == (1, 7), "saved cursor at (1,7)", out);
            },
        },
        Fixture {
            name: "alternate_screen_active",
            cols: 20,
            rows: 5,
            scrollback: 100,
            steps: vec![feed(
                "normal1\r\nnormal2\x1b[?1049hALT\x1b[4;1Hbottom\x1b[?1004h",
            )],
            exclusions: &[],
            expect: |dump, model, out| {
                check(dump.alternate.is_some(), "alternate screen active", out);
                check_text(dump, 1, "       ALT", out);
                check_text(dump, 3, "bottom", out);
                check(
                    dump.visible.first().map(|r| r.text()) == Some("normal1".into()),
                    "normal kept",
                    out,
                );
                check(model.tracker.focus, "focus mode set", out);
            },
        },
        Fixture {
            name: "alternate_screen_exit",
            cols: 20,
            rows: 5,
            scrollback: 100,
            steps: vec![feed(
                "one\r\ntwo\x1b[?1049h\x1b[2J\x1b[Hscratch\x1b[?1049lback\x1b[?47hx\x1b[?47ly",
            )],
            exclusions: &[],
            expect: |dump, _, out| {
                check(dump.alternate.is_none(), "normal screen active", out);
                check_text(dump, 0, "one", out);
                check_text(dump, 1, "twoback y", out);
            },
        },
        Fixture {
            name: "ris_and_erase",
            cols: 20,
            rows: 4,
            scrollback: 10,
            steps: vec![feed(concat!(
                "junk\x1b[31m\x1b[?1004h\x1b[2;3r\x1b(0\x1bc",
                "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\x1b[44m\x1b[2J\x1b[3J\x1b[m\x1b[Hafter",
            ))],
            exclusions: &[],
            expect: |dump, model, out| {
                check(dump.scrollback.is_empty(), "ED 3 cleared scrollback", out);
                check_text(dump, 0, "after", out);
                check_cell(
                    dump,
                    (2, 5),
                    |c| c.bg == Color::Idx(4),
                    "ED 2 erases with bg",
                    out,
                );
                check(
                    !model.tracker.focus && model.tracker.region().is_none(),
                    "RIS reset",
                    out,
                );
                check(
                    model.tracker.translation().is_none(),
                    "RIS reset charsets",
                    out,
                );
            },
        },
    ];
    fixtures.extend(more::corpus());
    fixtures.extend(xterm::corpus());
    fixtures
}
