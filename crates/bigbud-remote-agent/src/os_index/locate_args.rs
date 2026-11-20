//! Pure parts of the Linux `plocate` adapter: the argument list, the NUL-separated output parser,
//! the `locate` fallback's compatibility check and the exit-status classification.
//!
//! `plocate` (GPL-2.0) is only ever run as a separate process, never linked, and never through a
//! shell. The query is passed as one argument after `--`, as a glob that can only match a literal
//! substring of the file name: every glob metacharacter is backslash-escaped, which `plocate`,
//! `mlocate` and GNU `locate` all honour (`fnmatch` without `FNM_NOESCAPE`).

use super::error::OsIndexError;

/// `--limit` passed to `locate`. The index covers the whole disk and has no scope option, so
/// rows outside the scopes are dropped while streaming; this bounds that work.
pub const LOCATE_RECORD_LIMIT: usize = 20_000;
/// Longest accepted output record; Linux paths are at most 4096 bytes (`PATH_MAX`).
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

/// Backslash-escapes `\`, `*`, `?`, `[` and `]` so `value` matches only itself inside a glob.
/// Control characters (including NUL and newlines) are rejected.
pub fn escape_glob_literal(value: &str) -> Result<String, OsIndexError> {
    let mut escaped = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        if character.is_control() {
            return Err(OsIndexError::ControlCharacter);
        }
        if matches!(character, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    Ok(escaped)
}

/// Arguments for a case-insensitive file-name substring search with NUL-terminated output:
/// `-i -b -0 -l <limit> -- *<escaped query>*`. Short options, because `plocate`, `mlocate` and GNU
/// `locate` spell them identically. The explicit `*…*` keeps the pattern a glob in every
/// implementation (they would otherwise treat a metacharacter-free pattern as a substring but an
/// escaped one as an anchored glob).
pub fn locate_args(query: &str) -> Result<Vec<String>, OsIndexError> {
    let literal = escape_glob_literal(query)?;
    Ok(vec![
        "-i".to_owned(),
        "-b".to_owned(),
        "-0".to_owned(),
        "-l".to_owned(),
        LOCATE_RECORD_LIMIT.to_string(),
        "--".to_owned(),
        format!("*{literal}*"),
    ])
}

/// Whether `locate --version` names an implementation with the options and glob semantics above.
pub fn is_compatible_locate(version_output: &str) -> bool {
    let lower = version_output.to_ascii_lowercase();
    ["plocate", "mlocate", "findutils"]
        .iter()
        .any(|name| lower.contains(name))
}

/// How a finished `locate` run is read. `plocate`, `mlocate` and GNU `locate` all exit 0 when
/// something matched and 1 both for "no match" and for errors, which they explain on stderr
/// (missing or unreadable database, unknown option). So: 0 is success, a silent 1 without rows
/// is "no match", and anything else (an error message, another code, a signal, or a failure after
/// rows were printed) means the index is unavailable.
pub fn classify_exit(
    code: Option<i32>,
    stderr_written: bool,
    records: usize,
) -> Result<(), OsIndexError> {
    match code {
        Some(0) => Ok(()),
        Some(1) if !stderr_written && records == 0 => Ok(()),
        _ => Err(OsIndexError::Unavailable),
    }
}

/// Splits NUL-terminated output into records across arbitrary chunk boundaries. Records that are
/// empty, longer than [`MAX_RECORD_BYTES`] or not UTF-8 are counted but not returned, and an
/// unterminated tail (a run that was stopped mid-record) is never returned.
#[derive(Debug, Default)]
pub struct NulRecords {
    pending: Vec<u8>,
    overlong: bool,
    records: usize,
}

impl NulRecords {
    /// The records completed by `chunk`, in order.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut complete = Vec::new();
        let mut parts = chunk.split(|byte| *byte == 0).peekable();
        while let Some(part) = parts.next() {
            let terminated = parts.peek().is_some();
            if !self.overlong {
                if self.pending.len() + part.len() > MAX_RECORD_BYTES {
                    self.overlong = true;
                    self.pending.clear();
                } else {
                    self.pending.extend_from_slice(part);
                }
            }
            if !terminated {
                break;
            }
            self.records += 1;
            let record = std::mem::take(&mut self.pending);
            let overlong = std::mem::replace(&mut self.overlong, false);
            if overlong || record.is_empty() {
                continue;
            }
            if let Ok(text) = String::from_utf8(record) {
                complete.push(text);
            }
        }
        complete
    }

    /// NUL-terminated records seen so far, including skipped ones.
    pub fn records(&self) -> usize {
        self.records
    }
}
