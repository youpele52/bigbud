//! Pure `locate` adapter tests: argument building, glob escaping, output parsing and exit
//! classification. They run on every platform.

use super::error::OsIndexError;
use super::locate_args::{
    LOCATE_RECORD_LIMIT, MAX_RECORD_BYTES, NulRecords, classify_exit, escape_glob_literal,
    is_compatible_locate, locate_args,
};

#[test]
fn glob_escaping_backslashes_every_metacharacter() {
    let cases = [
        ("report", "report"),
        ("*", "\\*"),
        ("?", "\\?"),
        ("[a-z]", "\\[a-z\\]"),
        ("a\\b", "a\\\\b"),
        ("-rf", "-rf"),
        ("$(id)`x`;|&", "$(id)`x`;|&"),
        ("pläne ✓", "pläne ✓"),
    ];
    for (input, expected) in cases {
        assert_eq!(escape_glob_literal(input).unwrap(), expected, "{input:?}");
    }
    for control in ["a\nb", "a\0b", "\r", "\u{1b}[31m"] {
        assert_eq!(
            escape_glob_literal(control),
            Err(OsIndexError::ControlCharacter),
            "{control:?}"
        );
    }
}

/// After removing escape pairs, no glob metacharacter may remain between the outer `*…*`.
#[test]
fn the_pattern_can_only_match_a_literal_substring() {
    for attack in [
        "*",
        "?",
        "[!a]*",
        "\\",
        "\\*",
        "a]b[c",
        "--help",
        "-d /etc/shadow",
    ] {
        let args = locate_args(attack).unwrap();
        let pattern = args.last().unwrap();
        let body = pattern
            .strip_prefix('*')
            .and_then(|rest| rest.strip_suffix('*'))
            .unwrap();
        let mut characters = body.chars();
        while let Some(character) = characters.next() {
            if character == '\\' {
                let escaped = characters.next().unwrap();
                assert!(
                    matches!(escaped, '\\' | '*' | '?' | '[' | ']'),
                    "{attack:?}"
                );
                continue;
            }
            assert!(!matches!(character, '*' | '?' | '[' | ']'), "{attack:?}");
        }
    }
}

#[test]
fn arguments_are_fixed_options_then_one_pattern_after_the_separator() {
    let limit = LOCATE_RECORD_LIMIT.to_string();
    assert_eq!(
        locate_args("-d /etc/shadow").unwrap(),
        [
            "-i",
            "-b",
            "-0",
            "-l",
            limit.as_str(),
            "--",
            "*-d /etc/shadow*"
        ]
    );
    assert_eq!(locate_args("a\nb"), Err(OsIndexError::ControlCharacter));
}

#[test]
fn records_split_on_nul_across_chunk_boundaries() {
    let mut records = NulRecords::default();
    assert!(records.feed(b"/home/me/a").is_empty());
    assert_eq!(
        records.feed(b".txt\0/home/me/b\0/ho"),
        ["/home/me/a.txt", "/home/me/b"]
    );
    assert_eq!(records.feed(b"me/new\nline\0"), ["/home/new\nline"]);
    assert_eq!(records.records(), 3);
    // Empty and non-UTF-8 records are counted but not returned.
    assert_eq!(records.feed(b"\0\xff\xfe\0/ok\0"), ["/ok"]);
    assert_eq!(records.records(), 6);
    // A stopped run leaves an unterminated tail, which is never returned.
    assert!(records.feed(b"/home/me/partial").is_empty());
    assert_eq!(records.records(), 6);
}

#[test]
fn overlong_records_are_skipped_without_losing_the_next_one() {
    let mut records = NulRecords::default();
    let long = vec![b'a'; MAX_RECORD_BYTES];
    assert!(records.feed(&long).is_empty());
    assert!(records.feed(b"b").is_empty());
    assert_eq!(records.feed(b"tail\0/next\0"), ["/next"]);
    assert_eq!(records.records(), 2);
    let mut exact = NulRecords::default();
    let mut fits = vec![b'/'; MAX_RECORD_BYTES];
    fits.push(0);
    assert_eq!(exact.feed(&fits).len(), 1);
}

#[test]
fn exit_statuses_distinguish_no_match_from_an_unusable_index() {
    assert_eq!(classify_exit(Some(0), false, 3), Ok(()));
    assert_eq!(classify_exit(Some(0), true, 0), Ok(()));
    assert_eq!(classify_exit(Some(1), false, 0), Ok(()));
    for (code, stderr_written, records) in [
        (Some(1), true, 0),
        (Some(1), false, 2),
        (Some(2), false, 0),
        (None, false, 0),
        (None, true, 5),
    ] {
        assert_eq!(
            classify_exit(code, stderr_written, records),
            Err(OsIndexError::Unavailable),
            "{code:?} {stderr_written} {records}"
        );
    }
}

#[test]
fn only_known_locate_implementations_are_used_as_a_fallback() {
    assert!(is_compatible_locate(
        "plocate 1.1.19\nCopyright 2020 Steinar H. Gunderson"
    ));
    assert!(is_compatible_locate("mlocate 0.26\n"));
    assert!(is_compatible_locate("locate (GNU findutils) 4.9.0\n"));
    assert!(!is_compatible_locate(
        "Secure Locate 3.1 - Released March 7, 2006"
    ));
    assert!(!is_compatible_locate(""));
}
