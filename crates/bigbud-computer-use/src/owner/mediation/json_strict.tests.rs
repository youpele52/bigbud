#![allow(clippy::unwrap_used)]
use super::json_strict::{StrictRefusal, parse_strict};

const MAX: usize = 4096;

#[test]
fn accepts_well_formed_json_with_repeated_keys_in_distinct_objects() {
    let value = parse_strict(br#"{"a":[{"k":1},{"k":2}],"b":{"k":"}\",{[:"}}"#, MAX).unwrap();
    assert_eq!(value["a"][1]["k"], 2);
    assert_eq!(value["b"]["k"], "}\",{[:");
}

#[test]
fn refuses_duplicate_keys_including_escaped_spellings_and_nested_objects() {
    for frame in [
        &br#"{"pid":1,"pid":2}"#[..],
        br#"{"pid":1,"p\u0069d":2}"#,
        br#"{"x":{"a":1,"b":{"c":1,"c":2}}}"#,
        br#"[{"a":1},{"b":1,"b\/":1,"b":2}]"#,
        "{\"\\ud83d\\ude00\":1,\"\u{1F600}\":2}".as_bytes(),
    ] {
        assert_eq!(
            parse_strict(frame, MAX),
            Err(StrictRefusal::DuplicateKey),
            "{}",
            String::from_utf8_lossy(frame)
        );
    }
    // `"b\/"` decodes to `b/`, a different key from `b`.
    assert!(parse_strict(br#"{"b":1,"b\/":2}"#, MAX).is_ok());
}

#[test]
fn values_equal_to_keys_are_not_keys() {
    assert!(parse_strict(br#"{"a":"a","b":["a","a"],"c":{"a":"c"}}"#, MAX).is_ok());
}

#[test]
fn bounds_are_checked_before_parsing_and_malformed_input_refuses() {
    let big = vec![b' '; MAX + 1];
    assert_eq!(parse_strict(&big, MAX), Err(StrictRefusal::Oversized));
    for frame in [
        &b""[..],
        b"{",
        b"{\"a\":1,}",
        b"{\"a\" 1}",
        b"\xff",
        br#"{"a":"\ud800"}"#,
    ] {
        assert_eq!(parse_strict(frame, MAX), Err(StrictRefusal::Malformed));
    }
}
