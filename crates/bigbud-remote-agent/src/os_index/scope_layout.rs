//! Platform conventions for the "this computer" scope candidates. Pure, so every platform's
//! layout is tested on every platform.
//!
//! - macOS: home children except `Library`, plus iCloud Drive and File Provider storage.
//! - Windows: profile children except `AppData`; OneDrive's Known Folder Move puts Desktop,
//!   Documents and Pictures under `OneDrive*` profile folders.
//! - Linux: home children; `~/.config/user-dirs.dirs` may name localised common folders.

use std::path::{Component, Path, PathBuf};

use super::scope::{CLOUD_FOLDERS, COMMON_FOLDERS, HomeChild, OsIndexScopeLevel};

/// XDG user-dirs keys for the common folders (`XDG_DOWNLOAD_DIR` is singular in the spec).
const XDG_COMMON_KEYS: [&str; 5] = [
    "XDG_DESKTOP_DIR",
    "XDG_DOCUMENTS_DIR",
    "XDG_DOWNLOAD_DIR",
    "XDG_MUSIC_DIR",
    "XDG_PICTURES_DIR",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeLayout {
    /// Home child holding application state and caches, never searched as a whole
    /// (ASCII case-insensitive).
    pub noise_folder: Option<&'static str>,
    /// Home-relative folders inside the noise folder that hold user files.
    pub cloud_folders: &'static [&'static str],
    /// Home children starting with this prefix may hold redirected common folders.
    pub synced_parent_prefix: Option<&'static str>,
    /// Whether `~/.config/user-dirs.dirs` can name the common folders.
    pub xdg_user_dirs: bool,
}

impl ScopeLayout {
    pub const MACOS: Self = Self {
        noise_folder: Some("Library"),
        cloud_folders: &CLOUD_FOLDERS,
        synced_parent_prefix: None,
        xdg_user_dirs: false,
    };
    pub const WINDOWS: Self = Self {
        noise_folder: Some("AppData"),
        cloud_folders: &[],
        synced_parent_prefix: Some("OneDrive"),
        xdg_user_dirs: false,
    };
    pub const LINUX: Self = Self {
        noise_folder: None,
        cloud_folders: &[],
        synced_parent_prefix: None,
        xdg_user_dirs: true,
    };
    /// The layout of the platform this agent was built for (other Unix systems use Linux's).
    pub const CURRENT: Self = if cfg!(target_os = "macos") {
        Self::MACOS
    } else if cfg!(windows) {
        Self::WINDOWS
    } else {
        Self::LINUX
    };
}

/// Home-relative scope candidates for `level`. `children` is the home listing and `xdg_common`
/// the folders named by `user-dirs.dirs` (only used at the `common-folders` level). Only real
/// folders listed in home qualify as top-level candidates (symlinks could point anywhere), hidden
/// folders are skipped (dot folders hold tool state, not documents) and the noise folder is never
/// searched as a whole. Nested candidates are checked for existence when they are resolved.
pub fn scope_candidates(
    layout: &ScopeLayout,
    level: OsIndexScopeLevel,
    children: &[HomeChild],
    xdg_common: &[PathBuf],
) -> Vec<PathBuf> {
    let folders = || children.iter().filter(|child| child.is_directory);
    let mut candidates: Vec<PathBuf> = match level {
        OsIndexScopeLevel::CommonFolders => {
            let synced_parents = folders().filter(|child| {
                layout
                    .synced_parent_prefix
                    .is_some_and(|prefix| child.name.starts_with(prefix))
            });
            let synced = synced_parents.flat_map(|parent| {
                COMMON_FOLDERS
                    .iter()
                    .map(move |name| Path::new(&parent.name).join(name))
            });
            folders()
                .filter(|child| COMMON_FOLDERS.contains(&child.name.as_str()))
                .map(|child| PathBuf::from(&child.name))
                .chain(synced)
                .chain(xdg_common.iter().cloned())
                .collect()
        }
        OsIndexScopeLevel::Unrestricted => folders()
            .filter(|child| {
                !child.name.starts_with('.')
                    && !layout
                        .noise_folder
                        .is_some_and(|noise| child.name.eq_ignore_ascii_case(noise))
            })
            .map(|child| PathBuf::from(&child.name))
            .chain(layout.cloud_folders.iter().map(PathBuf::from))
            .collect(),
    };
    candidates.sort();
    candidates.dedup();
    candidates
}

/// Home-relative common folders named in a `user-dirs.dirs` file. Only the documented
/// `XDG_<NAME>_DIR="$HOME/<relative path>"` form is accepted; absolute paths, other variables,
/// backslash escapes, `.`/`..` components and the bare home folder are ignored, so the file can
/// only point at folders below home.
pub fn parse_xdg_user_dirs(text: &str) -> Vec<PathBuf> {
    let mut folders = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if line.starts_with('#') || !XDG_COMMON_KEYS.contains(&key.trim()) {
            continue;
        }
        let relative = value
            .trim()
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .and_then(|value| value.strip_prefix("$HOME/"));
        let Some(relative) = relative.map(|relative| relative.trim_end_matches('/')) else {
            continue;
        };
        if relative.is_empty() || relative.contains(['\\', '"', '$']) {
            continue;
        }
        let path = PathBuf::from(relative);
        let plain = relative.split('/').all(|part| !part.is_empty())
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_)));
        if plain && !folders.contains(&path) {
            folders.push(path);
        }
    }
    folders
}
