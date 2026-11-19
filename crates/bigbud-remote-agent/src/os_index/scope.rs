//! Search scopes for "this computer" and the containment check applied to every result.
//!
//! Scoping to the home folder itself returns almost only `~/Library` noise (caches, package
//! stores), so the scopes are the home folder's visible children except `Library`, plus the two
//! cloud folders that live under it (system-wide search plan, research §a and Design §6).

use std::path::{Component, Path, PathBuf};

use super::error::OsIndexError;
use super::exclusions::Exclusions;

/// Home children searched at the `common-folders` File Access level.
pub const COMMON_FOLDERS: [&str; 5] = ["Desktop", "Documents", "Downloads", "Music", "Pictures"];
/// Cloud folders under `~/Library` searched at the `unrestricted` level: iCloud Drive and
/// File Provider storage (Dropbox, Google Drive, OneDrive, ...).
pub const CLOUD_FOLDERS: [&str; 2] = ["Library/Mobile Documents", "Library/CloudStorage"];

/// The File Access level that bounds the scopes (`none` never reaches the agent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Home-relative scope candidates for `level`. Pure: `children` is the home listing. Only real
/// folders qualify (symlinks could point anywhere), hidden folders are skipped (dot folders hold
/// tool state, not documents) and `Library` is never searched as a whole.
pub fn scope_candidates(level: OsIndexScopeLevel, children: &[HomeChild]) -> Vec<PathBuf> {
    let is_folder = |name: &str| {
        children
            .iter()
            .any(|child| child.is_directory && child.name == name)
    };
    let mut candidates: Vec<PathBuf> = match level {
        OsIndexScopeLevel::CommonFolders => COMMON_FOLDERS
            .iter()
            .filter(|name| is_folder(name))
            .map(PathBuf::from)
            .collect(),
        OsIndexScopeLevel::Unrestricted => children
            .iter()
            .filter(|child| {
                child.is_directory
                    && !child.name.starts_with('.')
                    && !child.name.eq_ignore_ascii_case("Library")
            })
            .map(|child| PathBuf::from(&child.name))
            .chain(CLOUD_FOLDERS.iter().map(PathBuf::from))
            .collect(),
    };
    candidates.sort();
    candidates.dedup();
    candidates
}

/// Resolves the scopes for `home` and `level`: lists home, keeps candidates that exist as real
/// folders, canonicalises them, and drops any that resolve outside home or are excluded. Missing
/// or unreadable candidates only narrow the search, so they are skipped rather than failing it.
pub fn resolve_scopes(home: &Path, level: OsIndexScopeLevel) -> Result<Vec<PathBuf>, OsIndexError> {
    let home = std::fs::canonicalize(home).map_err(|_| OsIndexError::HomeUnavailable)?;
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
    let mut scopes = Vec::new();
    for candidate in scope_candidates(level, &children) {
        let path = home.join(&candidate);
        // Cloud folders sit two levels down; require a real folder there too.
        let is_real_folder =
            std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir());
        if !is_real_folder {
            continue;
        }
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            continue;
        };
        if canonical.starts_with(&home)
            && canonical.to_str().is_some()
            && !exclusions.excludes_scope(&canonical)
        {
            scopes.push(canonical);
        }
    }
    Ok(scopes)
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
