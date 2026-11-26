//! Scanner: `vte`-equivalent tokenization, held tails, and bounded control strings.

use super::super::scanner::{Scanner, Seq, TAIL_CAP, Token};

fn tokens(scanner: &mut Scanner, bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    scanner.scan(bytes, &mut |token| {
        out.push(match token {
            Token::Text { raw, .. } => format!("text:{}", String::from_utf8_lossy(raw)),
            Token::Shift { shift_out, .. } => format!("shift:{shift_out}"),
            Token::Dropped { .. } => "dropped".to_owned(),
            Token::Seq { seq, raw, .. } => match seq {
                Seq::Csi {
                    params,
                    final_byte,
                    intermediates,
                } => format!(
                    "csi:{}{:?}{}",
                    String::from_utf8_lossy(intermediates),
                    params.groups().collect::<Vec<_>>(),
                    char::from(final_byte)
                ),
                Seq::Esc { final_byte, .. } => format!("esc:{}", char::from(final_byte)),
                Seq::Osc { payload, .. } => format!("osc:{}", String::from_utf8_lossy(payload)),
                Seq::Other => format!("other:{}", raw.len()),
            },
        });
    });
    out
}

#[test]
fn csi_parameters_and_subparameters_match_vte_grouping() {
    let mut scanner = Scanner::default();
    let out = tokens(
        &mut scanner,
        b"\x1b[1:2;3m\x1b[?1049h\x1b[38;2;1;2;3m\x1b[m",
    );
    assert_eq!(
        out,
        [
            "csi:[[1, 2], [3]]m",
            "csi:?[[1049]]h",
            "csi:[[38], [2], [1], [2], [3]]m",
            "csi:[[0]]m"
        ]
    );
}

#[test]
fn sequences_split_across_chunks_are_held_and_emitted_once() {
    let mut scanner = Scanner::default();
    assert_eq!(tokens(&mut scanner, b"ab\x1b[3"), ["text:ab"]);
    assert_eq!(scanner.pending_tail().as_ref(), b"\x1b[3");
    assert_eq!(tokens(&mut scanner, b"1mcd"), ["csi:[[31]]m", "text:cd"]);
    assert!(scanner.pending_tail().is_empty());
    assert_eq!(tokens(&mut scanner, b"\x1b]0;ti"), Vec::<String>::new());
    assert_eq!(tokens(&mut scanner, b"tle\x07"), ["osc:0;title"]);
}

#[test]
fn partial_utf8_is_held_until_complete() {
    let mut scanner = Scanner::default();
    let snowman = "☃".as_bytes();
    let (head, tail) = snowman.split_at(1);
    assert_eq!(tokens(&mut scanner, &[b"x", head].concat()), ["text:x"]);
    assert_eq!(scanner.pending_tail().as_ref(), head);
    assert_eq!(tokens(&mut scanner, tail), ["text:☃"]);
    assert!(scanner.pending_tail().is_empty());
}

#[test]
fn osc_terminated_by_esc_restarts_an_escape_like_vte() {
    let mut scanner = Scanner::default();
    let out = tokens(&mut scanner, b"\x1b]8;;https://x\x1b\\link");
    assert_eq!(out, ["osc:8;;https://x", "esc:\\", "text:link"]);
}

#[test]
fn can_aborts_and_esc_restarts_a_csi() {
    let mut scanner = Scanner::default();
    let out = tokens(&mut scanner, b"\x1b[12\x18a\x1b[3\x1b[4mb");
    assert_eq!(
        out,
        ["other:5", "text:a", "other:3", "csi:[[4]]m", "text:b"]
    );
}

#[test]
fn shift_in_and_out_are_tokens() {
    let mut scanner = Scanner::default();
    assert_eq!(
        tokens(&mut scanner, b"a\x0eb\x0f"),
        ["text:a", "shift:true", "text:b", "shift:false"]
    );
}

#[test]
fn oversized_strings_are_dropped_with_a_bounded_synthetic_tail() {
    let mut scanner = Scanner::default();
    let mut input = b"\x1b]52;c;".to_vec();
    input.extend(std::iter::repeat_n(b'A', TAIL_CAP * 2));
    assert!(tokens(&mut scanner, &input).is_empty());
    assert_eq!(scanner.pending_tail().as_ref(), b"\x1b]1337;");
    assert!(
        scanner.held_bytes() <= TAIL_CAP * 2,
        "held state stays bounded"
    );
    assert_eq!(tokens(&mut scanner, b"AAAA\x07ok"), ["dropped", "text:ok"]);
    assert!(scanner.pending_tail().is_empty());
}

#[test]
fn excess_parameters_set_ignoring_without_overflow() {
    let mut scanner = Scanner::default();
    let input = format!("\x1b[{}m", "1;".repeat(40));
    let mut ignoring = false;
    scanner.scan(input.as_bytes(), &mut |token| {
        if let Token::Seq {
            seq: Seq::Csi { params, .. },
            ..
        } = token
        {
            ignoring = params.ignoring;
            assert_eq!(params.groups().count(), 32);
        }
    });
    assert!(ignoring);
}
