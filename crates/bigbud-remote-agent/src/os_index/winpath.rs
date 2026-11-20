//! Windows path spellings. `std::fs::canonicalize` returns verbatim paths (`\\?\C:\Users\me`),
//! while the Windows Search index reports plain drive paths (`C:\Users\me\x.txt`) in whatever
//! letter case it stored. Pure string functions, so they are tested on every platform.

/// Device names Windows reserves in every folder, with or without an extension.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
/// Longest plain path (in UTF-16 units, without the terminator) that needs no long-path support.
const MAX_PLAIN_PATH_UNITS: usize = 259;

/// The plain spelling of a verbatim drive path (`\\?\C:\Users\me` → `C:\Users\me`), or `None`
/// when dropping the prefix could change which file is meant: not a drive path, too long, or a
/// component that the plain form would reinterpret (empty, `.`/`..`, a trailing dot or space,
/// a reserved device name, or a `/`).
pub fn plain_disk_path(text: &str) -> Option<&str> {
    let rest = text.strip_prefix(r"\\?\")?;
    let below_root = below_drive_root(rest)?;
    if rest.contains('/') || rest.encode_utf16().count() > MAX_PLAIN_PATH_UNITS {
        return None;
    }
    let plain = below_root.is_empty() || below_root.split('\\').all(is_plain_name);
    plain.then_some(rest)
}

/// `path` without its verbatim prefix when [`plain_disk_path`] allows it, else unchanged.
#[cfg(windows)]
pub fn plain_path(path: std::path::PathBuf) -> std::path::PathBuf {
    match path.to_str().and_then(plain_disk_path) {
        Some(plain) => std::path::PathBuf::from(plain),
        None => path,
    }
}

/// Rewrites `path` to use the exact spelling of the first scope that contains it, comparing ASCII
/// case-insensitively (NTFS folders are case-insensitive by default) on `\` boundaries. `None`
/// when no scope contains it; the caller then keeps the row as reported and the shared scope
/// check drops it.
pub fn align_to_scopes(path: &str, scopes: &[&str]) -> Option<String> {
    scopes.iter().find_map(|scope| {
        let head = path.get(..scope.len())?;
        let tail = path.get(scope.len()..)?;
        let contained =
            head.eq_ignore_ascii_case(scope) && (tail.is_empty() || tail.starts_with('\\'));
        contained.then(|| format!("{scope}{tail}"))
    })
}

/// The part of a plain drive path after `X:\`, or `None` when `path` does not start that way.
pub fn below_drive_root(path: &str) -> Option<&str> {
    let mut characters = path.chars();
    match (characters.next(), characters.next(), characters.next()) {
        (Some(letter), Some(':'), Some('\\')) if letter.is_ascii_alphabetic() => {
            Some(characters.as_str())
        }
        _ => None,
    }
}

fn is_plain_name(name: &str) -> bool {
    let stem = name
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .trim_end();
    !name.is_empty()
        && !name.ends_with(['.', ' '])
        && !RESERVED_NAMES
            .iter()
            .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}
