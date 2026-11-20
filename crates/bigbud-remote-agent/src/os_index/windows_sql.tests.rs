//! Pure Windows Search tests: SQL escaping and the path spellings. They run on every platform.

use super::error::OsIndexError;
use super::windows_sql::{escape_like_literal, name_query_sql, scope_literal};
use super::winpath::{align_to_scopes, plain_disk_path};

const DOCUMENTS: &str = r"C:\Users\me\Documents";

#[test]
fn like_escaping_brackets_every_wildcard_and_doubles_quotes() {
    let cases = [
        ("report", "report"),
        ("100%", "100[%]"),
        ("a_b", "a[_]b"),
        ("[draft]", "[[]draft]"),
        ("o'brien", "o''brien"),
        ("''", "''''"),
        ("*?\\\"", "*?\\\""),
        ("pläne ✓", "pläne ✓"),
    ];
    for (input, expected) in cases {
        assert_eq!(escape_like_literal(input).unwrap(), expected, "{input:?}");
    }
    for control in ["a\nb", "a\0b", "a\tb", "\u{7f}", "\u{85}"] {
        assert_eq!(
            escape_like_literal(control),
            Err(OsIndexError::ControlCharacter),
            "{control:?}"
        );
    }
}

/// Every unescaped `'` in the WHERE clause must be one of the literal delimiters, and the LIKE
/// literal must contain no bare wildcard: a query can never end the literal or widen the match.
#[test]
fn injection_attempts_stay_inside_one_literal() {
    let attacks = [
        "' OR 1=1 --",
        "x' OR System.FileName LIKE '%",
        "'; DROP TABLE SystemIndex; --",
        "%",
        "_",
        "[a-z]",
        "') OR SCOPE='file:C:/' OR ('",
    ];
    for attack in attacks {
        let sql = name_query_sql(attack, &[DOCUMENTS], 200).unwrap();
        let like = sql.split_once(" LIKE '").unwrap().1;
        let literal = like.strip_suffix('\'').unwrap();
        let body = literal
            .strip_prefix('%')
            .unwrap()
            .strip_suffix('%')
            .unwrap();
        // Outside doubled quotes, no quote remains inside the literal.
        assert!(!body.replace("''", "").contains('\''), "{attack:?}: {sql}");
        // Outside bracket escapes, no wildcard remains inside the literal.
        let unbracketed = body
            .replace("[%]", "")
            .replace("[_]", "")
            .replace("[[]", "");
        assert!(!unbracketed.contains(['%', '_', '[']), "{attack:?}: {sql}");
        assert!(sql.starts_with("SELECT TOP 200 System.ItemPathDisplay, System.Size, "));
    }
}

#[test]
fn query_sql_lists_columns_scopes_and_the_name_literal() {
    let downloads = r"C:\Users\me\Downloads";
    assert_eq!(
        name_query_sql("tax_2026", &[DOCUMENTS, downloads], 200).unwrap(),
        "SELECT TOP 200 System.ItemPathDisplay, System.Size, System.DateModified, \
         System.FileAttributes FROM SystemIndex WHERE (SCOPE='file:C:/Users/me/Documents' OR \
         SCOPE='file:C:/Users/me/Downloads') AND System.FileName LIKE '%tax[_]2026%'"
    );
    assert_eq!(name_query_sql("x", &[], 200), Err(OsIndexError::NoScopes));
    assert_eq!(
        name_query_sql("x\n", &[DOCUMENTS], 200),
        Err(OsIndexError::ControlCharacter)
    );
}

#[test]
fn scope_literals_accept_only_plain_drive_folders() {
    assert_eq!(
        scope_literal(r"D:\Users\o'neil\My Files").as_deref(),
        Some("file:D:/Users/o''neil/My Files")
    );
    for rejected in [
        r"\\?\C:\Users\me",
        r"\\server\share\docs",
        r"Users\me",
        "/home/me",
        r"C:/Users/me",
        "C:",
        "C:\\Users\\a\nb",
    ] {
        assert_eq!(scope_literal(rejected), None, "{rejected:?}");
        assert_eq!(
            name_query_sql("x", &[DOCUMENTS, rejected], 200),
            Err(OsIndexError::InvalidScope),
            "{rejected:?}"
        );
    }
}

#[test]
fn verbatim_prefixes_are_dropped_only_when_lossless() {
    assert_eq!(plain_disk_path(r"\\?\C:\Users\me"), Some(r"C:\Users\me"));
    assert_eq!(plain_disk_path(r"\\?\d:\"), Some(r"d:\"));
    let long = format!(r"\\?\C:\{}", "a".repeat(257));
    for kept in [
        r"C:\Users\me",
        r"\\?\UNC\server\share",
        r"\\?\Volume{0}\x",
        r"\\?\C:\Users\me.",
        r"\\?\C:\Users\me \x",
        r"\\?\C:\Users\..\x",
        r"\\?\C:\Users\\x",
        r"\\?\C:\Users\CON",
        r"\\?\C:\Users\nul.txt",
        r"\\?\C:\Users\Com1 .log",
        r"\\?\C:\Users/me",
        long.as_str(),
    ] {
        assert_eq!(plain_disk_path(kept), None, "{kept:?}");
    }
    assert_eq!(
        plain_disk_path(r"\\?\C:\Users\console\connection.txt"),
        Some(r"C:\Users\console\connection.txt")
    );
}

#[test]
fn rows_take_the_scope_spelling_on_separator_boundaries_only() {
    let scopes = [DOCUMENTS, r"C:\Users\me\OneDrive"];
    assert_eq!(
        align_to_scopes(r"c:\users\ME\documents\Taxes\2026.pdf", &scopes).as_deref(),
        Some(r"C:\Users\me\Documents\Taxes\2026.pdf")
    );
    assert_eq!(
        align_to_scopes(r"C:\USERS\me\onedrive", &scopes).as_deref(),
        Some(r"C:\Users\me\OneDrive")
    );
    for outside in [
        r"C:\Users\me\DocumentsOld\x",
        r"C:\Users\me",
        r"D:\Users\me\Documents\x",
        "C:\\Users\\me\\Docüments\\x",
        "",
    ] {
        assert_eq!(align_to_scopes(outside, &scopes), None, "{outside:?}");
    }
}
