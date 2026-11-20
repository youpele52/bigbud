//! Builds the Spotlight name predicate. User input is always placed inside one double-quoted
//! string with every metacharacter backslash-escaped (the `mdfind -literal` equivalent), so a
//! query can never close the string, add wildcards or inject predicate syntax.

use super::error::OsIndexError;

/// Escapes `value` for use inside a double-quoted MDQuery string: `\`, `"`, `*` and `?` gain a
/// backslash; control characters (including NUL and newlines) are rejected.
pub fn escape_query_literal(value: &str) -> Result<String, OsIndexError> {
    let mut escaped = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        if character.is_control() {
            return Err(OsIndexError::ControlCharacter);
        }
        if matches!(character, '\\' | '"' | '*' | '?') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    Ok(escaped)
}

/// Case- and diacritic-insensitive substring match on the file-system name. `kMDItemFSName` is
/// used rather than `kMDItemDisplayName`, which can be localised or hide the extension, so the
/// match agrees with the basename ranking applied afterwards.
pub fn name_predicate(query: &str) -> Result<String, OsIndexError> {
    let literal = escape_query_literal(query)?;
    Ok(format!("kMDItemFSName == \"*{literal}*\"cd"))
}
