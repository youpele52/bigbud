//! Builds the Windows Search SQL for a name query. The OLE DB provider takes no bound parameters,
//! so the user's text only ever appears inside one single-quoted `LIKE` literal: `'` is doubled
//! and the `LIKE` wildcards `%`, `_` and `[` are bracketed so they match themselves. Scope folders
//! go into `SCOPE='file:…'` literals with the same quoting. Pure, so it is tested everywhere.

use super::error::OsIndexError;
use super::winpath::below_drive_root;

/// Selected columns, in the order the rowset reader binds them (ordinals 1–4).
pub const SELECTED_COLUMNS: [&str; 4] = [
    "System.ItemPathDisplay",
    "System.Size",
    "System.DateModified",
    "System.FileAttributes",
];

/// Escapes `value` for use inside a single-quoted `LIKE` literal. Control characters (including
/// NUL and newlines) are rejected.
pub fn escape_like_literal(value: &str) -> Result<String, OsIndexError> {
    let mut escaped = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        match character {
            control if control.is_control() => return Err(OsIndexError::ControlCharacter),
            '\'' => escaped.push_str("''"),
            '%' => escaped.push_str("[%]"),
            '_' => escaped.push_str("[_]"),
            '[' => escaped.push_str("[[]"),
            other => escaped.push(other),
        }
    }
    Ok(escaped)
}

/// The `SCOPE` URL for a plain drive folder (`C:\Users\me\Documents` →
/// `file:C:/Users/me/Documents`), quoted for a string literal. `None` for anything else
/// (verbatim, UNC or relative paths, control characters), which the caller refuses.
pub fn scope_literal(scope: &str) -> Option<String> {
    let is_drive_path = below_drive_root(scope).is_some();
    if !is_drive_path || scope.contains('/') || scope.chars().any(char::is_control) {
        return None;
    }
    Some(format!(
        "file:{}",
        scope.replace('\\', "/").replace('\'', "''")
    ))
}

/// `SELECT TOP <limit> … FROM SystemIndex WHERE (<scopes>) AND System.FileName LIKE '%<query>%'`.
/// `System.FileName` is the on-disk name with its extension, like Spotlight's `kMDItemFSName`;
/// the index compares it case-insensitively.
pub fn name_query_sql(query: &str, scopes: &[&str], limit: usize) -> Result<String, OsIndexError> {
    let literal = escape_like_literal(query)?;
    let scope_terms = scopes
        .iter()
        .map(|scope| scope_literal(scope).map(|url| format!("SCOPE='{url}'")))
        .collect::<Option<Vec<_>>>()
        .ok_or(OsIndexError::InvalidScope)?;
    if scope_terms.is_empty() {
        return Err(OsIndexError::NoScopes);
    }
    Ok(format!(
        "SELECT TOP {limit} {} FROM SystemIndex WHERE ({}) AND System.FileName LIKE '%{literal}%'",
        SELECTED_COLUMNS.join(", "),
        scope_terms.join(" OR ")
    ))
}
