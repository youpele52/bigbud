//! Search scopes for "this computer" and the containment check applied to every result.
//!
//! Scoping to the home folder itself returns almost only `~/Library` noise (caches, package
//! stores), so the scopes are the home folder's visible children except `Library`, plus the two
//! cloud folders that live under it (system-wide search plan, research §a and Design §6).
//! Windows and Linux follow the same rule with their own layout (`scope_layout.rs`).

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::scope_layout::{ScopeLayout, parse_xdg_user_dirs, scope_candidates};

// `COMMON_FOLDERS`, `CLOUD_FOLDERS` and the macOS noise folder are pinned to
// `packages/shared/src/search/osIndexScopeFolders.json` by a parity test: the desktop File Access
// probe reads that file, so macOS asks about exactly the folders search later reads.

/// Home children searched at the `common-folders` File Access level.
pub const COMMON_FOLDERS: [&str; 5] = ["Desktop", "Documents", "Downloads", "Music", "Pictures"];
/// Cloud folders under `~/Library` searched at the `unrestricted` level: iCloud Drive and
/// File Provider storage (Dropbox, Google Drive, OneDrive, ...).
pub const CLOUD_FOLDERS: [&str; 2] = ["Library/Mobile Documents", "Library/CloudStorage"];

/// The File Access level that bounds the scopes (`none` never reaches the agent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OsIndexScopeLevel {
    CommonFolders,
    Unrestricted,
}

/// A direct child of the home folder, as listed without following symlinks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeChild {
    pub name: String,
    pub is_directory: bool,
}

/// Upper bound for `~/.config/user-dirs.dirs` (a few hundred bytes in practice).
const MAX_USER_DIRS_BYTES: u64 = 64 * 1024;

/// The home folder the scopes are resolved under: `USERPROFILE` on Windows (where `HOME` is
/// normally unset, or set by MSYS-style shells to a different folder) and `HOME` elsewhere.
/// `None` when the variable is unset or empty.
pub fn home_folder() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Resolves the scopes for `home` and `level` with this platform's [`ScopeLayout`].
pub fn resolve_scopes(home: &Path, level: OsIndexScopeLevel) -> Result<Vec<PathBuf>, OsIndexError> {
    resolve_scopes_with(home, level, &ScopeLayout::CURRENT)
}

/// Resolves with [`is_readable_folder`] as the per-candidate check.
pub(super) fn resolve_scopes_with(
    home: &Path,
    level: OsIndexScopeLevel,
    layout: &ScopeLayout,
) -> Result<Vec<PathBuf>, OsIndexError> {
    resolve_scopes_checked(home, level, layout, &is_readable_folder)
}

/// A real folder (not a symlink) whose listing opens. A declined privacy prompt (macOS
/// "Don't Allow") makes the listing fail, so that folder is skipped instead of failing search.
fn is_readable_folder(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        && std::fs::read_dir(path).is_ok()
}

/// Lists home, drops excluded candidates before touching them, keeps those `readable_folder`
/// accepts, canonicalises them, and drops any that resolve outside home or are excluded.
/// Missing or unreadable candidates only narrow the search, so they are skipped rather than
/// failing it.
pub(super) fn resolve_scopes_checked(
    home: &Path,
    level: OsIndexScopeLevel,
    layout: &ScopeLayout,
    readable_folder: &dyn Fn(&Path) -> bool,
) -> Result<Vec<PathBuf>, OsIndexError> {
    let home = plain_canonical(home).ok_or(OsIndexError::HomeUnavailable)?;
    let exclusions = Exclusions::embedded()?;
    let listing = std::fs::read_dir(&home).map_err(|_| OsIndexError::HomeUnavailable)?;
    let mut children = Vec::new();
    // Entries that fail to read or are not UTF-8 are skipped on purpose: they can only remove a
    // scope, never add one.
    for entry in listing.flatten() {
        let (Ok(file_type), Ok(name)) = (entry.file_type(), entry.file_name().into_string()) else {
            continue;
        };
        children.push(HomeChild {
            name,
            is_directory: file_type.is_dir(),
        });
    }
    let xdg_common = match level {
        OsIndexScopeLevel::CommonFolders if layout.xdg_user_dirs => read_xdg_user_dirs(&home),
        _ => Vec::new(),
    };
    let mut scopes = Vec::new();
    for candidate in scope_candidates(layout, level, &children, &xdg_common) {
        let path = home.join(&candidate);
        // Excluded folders are never touched, not even to check that they exist.
        if exclusions.excludes_scope(&path) {
            continue;
        }
        // Nested candidates (cloud, synced and XDG folders) are not in the home listing; require
        // a real, readable folder there too.
        if !readable_folder(&path) {
            continue;
        }
        let Some(canonical) = plain_canonical(&path) else {
            continue;
        };
        if canonical.starts_with(&home)
            && canonical.to_str().is_some()
            && !exclusions.excludes_scope(&canonical)
            && !scopes.contains(&canonical)
        {
            scopes.push(canonical);
        }
    }
    Ok(scopes)
}

/// The canonical form scopes are kept and compared in. On Windows the verbatim `\\?\` prefix
/// that `canonicalize` adds is removed when that is lossless, because the Windows Search index
/// reports plain drive paths.
pub(super) fn plain_canonical(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    let canonical = super::winpath::plain_path(canonical);
    Some(canonical)
}

/// Common folders named by `~/.config/user-dirs.dirs`. A missing, unreadable, oversized or
/// non-UTF-8 file names none, which only narrows the search.
fn read_xdg_user_dirs(home: &Path) -> Vec<PathBuf> {
    let Ok(file) = std::fs::File::open(home.join(".config/user-dirs.dirs")) else {
        return Vec::new();
    };
    let mut text = String::new();
    match file.take(MAX_USER_DIRS_BYTES + 1).read_to_string(&mut text) {
        Ok(read) if (read as u64) <= MAX_USER_DIRS_BYTES => parse_xdg_user_dirs(&text),
        Ok(_) | Err(_) => Vec::new(),
    }
}

/// Splits an OS-index result into its scope and the part below it. Returns `None` for anything
/// that is not a plain absolute path inside one of `scopes` (relative paths, `.`/`..`
/// components, repeated or trailing separators, NUL bytes, or paths outside every scope).
pub fn split_by_scope<'a>(path: &'a Path, scopes: &'a [PathBuf]) -> Option<(&'a Path, &'a Path)> {
    let components_are_plain = path.components().all(|component| {
        matches!(
            component,
            Component::RootDir | Component::Prefix(_) | Component::Normal(_)
        )
    });
    // `components()` silently drops interior `.` and collapses `//`, so also require the path to
    // be exactly its own normal form.
    let is_normal_form = path.components().collect::<PathBuf>().as_os_str() == path.as_os_str();
    let plain = path.is_absolute()
        && !path.as_os_str().as_encoded_bytes().contains(&0)
        && components_are_plain
        && is_normal_form;
    if !plain {
        return None;
    }
    scopes.iter().find_map(|scope| {
        path.strip_prefix(scope)
            .ok()
            .map(|below| (scope.as_path(), below))
    })
}
