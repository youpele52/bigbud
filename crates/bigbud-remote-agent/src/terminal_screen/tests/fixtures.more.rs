//! Corpus, part 2: links, modes, kitty keyboard, resize, an agent-TUI redraw stream,
//! character sets, pending wrap, unsupported attributes and oversized control strings.

use super::super::super::ExclusionKind;
use super::{Fixture, Step, check, check_cell, check_text, feed};
use vt100::Color;

fn agent_frames() -> String {
    let mut stream = String::from("\x1b[?25l\x1b[?2026h");
    stream.push_str(
        "╭──────────────────╮\r\n│ \x1b[1mbigbud\x1b[22m agent     │\r\n╰──────────────────╯\r\n",
    );
    stream.push_str(
        "\x1b[38;2;215;119;87m✻\x1b[39m Thinking…\r\n\x1b[2m  esc to interrupt\x1b[22m\x1b[?2026l",
    );
    for (glyph, status, detail) in [
        ("✶", "Reading files…", "3 files"),
        ("✳", "Editing…", "1 diff"),
    ] {
        stream.push_str("\x1b[?2026h\r\x1b[1A\x1b[2K");
        stream.push_str(&format!(
            "\x1b[38;2;215;119;87m{glyph}\x1b[39m {status}\r\n\x1b[2K\x1b[2m  {detail}\x1b[22m"
        ));
        stream.push_str("\x1b[?2026l");
    }
    stream.push_str("\r\n\x1b[48;5;236m\x1b[K> \x1b[m\x1b[?25h");
    stream
}

pub(super) fn corpus() -> Vec<Fixture> {
    vec![
        Fixture {
            name: "osc8_hyperlinks",
            cols: 30,
            rows: 3,
            scrollback: 100,
            steps: vec![feed(concat!(
                "\x1b]8;id=1;https://example.com\x1b\\link\x1b]8;;\x1b\\ plain\r\n",
                "\x1b]8;;https://open.example\x07tail",
            ))],
            exclusions: &[ExclusionKind::Osc8LinkTargets],
            expect: |dump, model, out| {
                check_text(dump, 0, "link plain", out);
                check_text(dump, 1, "tail", out);
                let open =
                    model.tracker.link.as_deref() == Some(b";https://open.example".as_slice());
                check(open, "open link tracked for re-opening", out);
            },
        },
        Fixture {
            name: "dec2026_synchronized_output",
            cols: 20,
            rows: 2,
            scrollback: 100,
            steps: vec![feed("\x1b[?2026hframe1\x1b[?2026l\x1b[?2026h\rframe2")],
            exclusions: &[],
            expect: |dump, model, out| {
                check_text(dump, 0, "frame2", out);
                check(model.tracker.sync_output, "2026 still set", out);
            },
        },
        Fixture {
            name: "focus_1004_and_input_modes",
            cols: 20,
            rows: 2,
            scrollback: 100,
            steps: vec![feed(
                "\x1b[?1004h\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[4 q\x1b[4hok",
            )],
            // Insert mode is not implemented by `vt100`: rows written in it are reported.
            exclusions: &[ExclusionKind::UnsupportedModes],
            expect: |dump, model, out| {
                check_text(dump, 0, "ok", out);
                check(
                    model.tracker.focus && model.tracker.insert,
                    "focus and insert tracked",
                    out,
                );
            },
        },
        Fixture {
            name: "kitty_keyboard_push_pop",
            cols: 20,
            rows: 2,
            scrollback: 100,
            steps: vec![feed(
                "\x1b[>1u\x1b[>3u\x1b[<u\x1b[=5;2ukb\x1b[?1049h\x1b[>8u",
            )],
            exclusions: &[ExclusionKind::KittyKeyboardHostOnly],
            expect: |_, model, out| {
                let stacks = [vec![5u16], vec![8u16]];
                check(
                    model.tracker.kitty == stacks,
                    "kitty stacks per screen",
                    out,
                );
            },
        },
        Fixture {
            name: "resize_shrink_grow_wrapped_scrollback",
            cols: 10,
            rows: 4,
            scrollback: 50,
            steps: vec![
                feed("0123456789ABCDEFGHIJ\r\nshort\r\nl1\r\nl2\r\nl3\r\nl4"),
                Step::Resize(6, 4),
                feed("\r\nnarrow\r\n"),
                Step::Resize(14, 5),
                feed("after resize\r\nlast"),
            ],
            exclusions: &[ExclusionKind::ReflowAfterWidthChange],
            expect: |dump, _, out| {
                check(dump.cols == 14 && dump.rows == 5, "final geometry", out);
                let rows = dump.screen().len();
                check_text(dump, rows - 2, "after resize", out);
                check_text(dump, rows - 1, "last", out);
            },
        },
        Fixture {
            name: "agent_tui_redraw_stream",
            cols: 40,
            rows: 8,
            scrollback: 100,
            steps: vec![Step::Feed(agent_frames().into_bytes())],
            exclusions: &[],
            expect: |dump, model, out| {
                check_text(dump, 0, "╭──────────────────╮", out);
                check_text(dump, 1, "│ bigbud agent     │", out);
                check_cell(dump, (1, 2), |c| c.flags == 1, "bold name", out);
                check_text(dump, 3, "✳ Editing…", out);
                check_cell(
                    dump,
                    (3, 0),
                    |c| c.fg == Color::Rgb(215, 119, 87),
                    "spinner colour",
                    out,
                );
                check_text(dump, 4, "  1 diff", out);
                check_cell(
                    dump,
                    (5, 30),
                    |c| c.bg == Color::Idx(236),
                    "EL keeps bg",
                    out,
                );
                check(
                    !dump.cursor_hidden && !model.tracker.sync_output,
                    "cursor shown",
                    out,
                );
            },
        },
        Fixture {
            name: "dec_special_graphics",
            cols: 10,
            rows: 4,
            scrollback: 100,
            steps: vec![feed(
                "\x1b(0lqqk\r\nx  x\r\nmqqj\x1b(B ok\r\n\x1b)0a\x0eq\x0fq\x1b(0",
            )],
            exclusions: &[],
            expect: |dump, model, out| {
                check_text(dump, 0, "┌──┐", out);
                check_text(dump, 1, "│  │", out);
                check_text(dump, 2, "└──┘ ok", out);
                check_text(dump, 3, "a─q", out);
                check(
                    model.tracker.translation().is_some(),
                    "G0 left as DEC graphics",
                    out,
                );
            },
        },
        Fixture {
            name: "pending_wrap_at_last_column",
            cols: 5,
            rows: 3,
            scrollback: 100,
            steps: vec![feed("abcde")],
            exclusions: &[],
            expect: |dump, _, out| {
                check_text(dump, 0, "abcde", out);
                check(dump.cursor == (0, 5), "cursor in pending wrap", out);
            },
        },
        Fixture {
            name: "unsupported_attributes",
            cols: 20,
            rows: 3,
            scrollback: 100,
            steps: vec![feed(
                "\x1b[9mstrike\x1b[29m ok\r\n\x1b[58;2;255;0;0;4munder\x1b[59;24m\x1b[1;2mbd\x1b[m",
            )],
            exclusions: &[ExclusionKind::UnsupportedAttributes],
            expect: |dump, _, out| {
                check_text(dump, 0, "strike ok", out);
                check_cell(
                    dump,
                    (1, 0),
                    |c| c.flags == 8 && c.fg == Color::Default,
                    "58 args not misparsed",
                    out,
                );
            },
        },
        Fixture {
            name: "oversized_control_strings",
            cols: 20,
            rows: 2,
            scrollback: 100,
            steps: vec![
                feed(&format!("\x1b]0;{}\x07after", "a".repeat(20_000))),
                feed(&format!("\x1bP1$q{}\x1b\\ dcs", "b".repeat(20_000))),
                feed(&format!("\r\n\x1b]2;{}", "c".repeat(20_000))),
            ],
            exclusions: &[],
            expect: |dump, model, out| {
                check_text(dump, 0, "after dcs", out);
                check(
                    model.scanner.pending_tail().as_ref() == b"\x1b]1337;",
                    "synthetic tail",
                    out,
                );
            },
        },
    ]
}
