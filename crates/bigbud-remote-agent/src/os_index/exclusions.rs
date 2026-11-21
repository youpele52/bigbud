//! Default "this computer" exclusions (system-wide search plan, §8). Matching results are dropped
//! inside the agent, before they can cross the protocol. The data lives in
//! `packages/shared/src/search/osIndexExclusions.json`, shared with the TypeScript matcher that
//! guards system-open of paths outside projects.
//!
//! Matching is ASCII case-insensitive (macOS volumes are case-insensitive by default) and fails
//! closed: a name pattern excludes the whole subtree of a matching folder, not only files.

use std::ffi::OsStr;
use std::path::{Component, Path};
use std::sync::OnceLock;

use serde_json::Value;

use super::error::OsIndexError;

const EMBEDDED_EXCLUSIONS: &str =
    include_str!("../../../../packages/shared/src/search/osIndexExclusions.json");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exclusions {
    /// Each pattern is a run of consecutive path components; a component may contain `*`.
    path_segments: Vec<Vec<String>>,
    /// Glob patterns (`*` only) matched against every component below the search scope.
    file_names: Vec<String>,
    /// Dependency, build and cache folders (`clutterFolders`): not private, only noise, so
    /// matching rows are skipped below the scope without counting as excluded.
    clutter_folders: Vec<Vec<String>>,
}

impl Exclusions {
    /// The list compiled into the agent, parsed once.
    pub fn embedded() -> Result<&'static Self, OsIndexError> {
        static PARSED: OnceLock<Option<Exclusions>> = OnceLock::new();
        PARSED
            .get_or_init(|| Self::parse(EMBEDDED_EXCLUSIONS).ok())
            .as_ref()
            .ok_or(OsIndexError::ExclusionsInvalid)
    }

    /// Parses `{ "pathSegments": [...], "fileNames": [...] }`. Empty lists, empty patterns and
    /// `.`/`..` components are rejected so a damaged list can never silently match nothing.
    pub fn parse(json: &str) -> Result<Self, OsIndexError> {
        let value: Value =
            serde_json::from_str(json).map_err(|_| OsIndexError::ExclusionsInvalid)?;
        let path_segments = segment_patterns(string_list(&value, "pathSegments")?)?;
        let clutter_folders = segment_patterns(string_list(&value, "clutterFolders")?)?;
        let file_names = string_list(&value, "fileNames")?;
        if file_names.iter().any(|name| name.contains('/')) {
            return Err(OsIndexError::ExclusionsInvalid);
        }
        Ok(Self {
            path_segments,
            file_names,
            clutter_folders,
        })
    }

    /// Whether a result must be dropped. `path` is the absolute result path and `below_scope` its
    /// part below the scope it was found in. Folder patterns look at the whole path; name patterns
    /// only below the scope, so a user or volume name such as `id_admin` cannot hide everything.
    pub fn excludes(&self, path: &Path, below_scope: &Path) -> bool {
        self.matches_segments(path)
            || below_scope
                .components()
                .any(|component| self.matches_component(component))
    }

    /// Whether a result lies in a dependency, build or cache folder below its scope.
    pub fn is_clutter(&self, below_scope: &Path) -> bool {
        segments_match(&self.clutter_folders, below_scope)
    }

    /// Whether a folder may not be used as a search scope at all.
    pub fn excludes_scope(&self, scope: &Path) -> bool {
        self.matches_segments(scope)
            || scope
                .file_name()
                .is_some_and(|name| self.matches_name(name))
    }

    fn matches_segments(&self, path: &Path) -> bool {
        segments_match(&self.path_segments, path)
    }

    fn matches_component(&self, component: Component<'_>) -> bool {
        match component {
            Component::Normal(name) => self.matches_name(name),
            _ => false,
        }
    }

    fn matches_name(&self, name: &OsStr) -> bool {
        let name = name.as_encoded_bytes();
        self.file_names
            .iter()
            .any(|pattern| glob_matches(pattern.as_bytes(), name))
    }
}

/// Whether any pattern (a run of consecutive components) occurs in `path`.
fn segments_match(patterns: &[Vec<String>], path: &Path) -> bool {
    let names: Vec<&[u8]> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.as_encoded_bytes()),
            _ => None,
        })
        .collect();
    patterns.iter().any(|pattern| {
        names.windows(pattern.len()).any(|window| {
            window
                .iter()
                .zip(pattern)
                .all(|(name, part)| glob_matches(part.as_bytes(), name))
        })
    })
}

/// Splits `a/b` patterns into components, rejecting empty, `.` and `..` components.
fn segment_patterns(patterns: Vec<String>) -> Result<Vec<Vec<String>>, OsIndexError> {
    patterns
        .into_iter()
        .map(|pattern| {
            let components: Vec<String> = pattern.split('/').map(str::to_owned).collect();
            let valid = components
                .iter()
                .all(|component| !component.is_empty() && component != "." && component != "..");
            if valid {
                Ok(components)
            } else {
                Err(OsIndexError::ExclusionsInvalid)
            }
        })
        .collect()
}

fn string_list(value: &Value, key: &str) -> Result<Vec<String>, OsIndexError> {
    let items = value
        .get(key)
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or(OsIndexError::ExclusionsInvalid)?;
    items
        .iter()
        .map(|item| match item.as_str() {
            Some(text) if !text.is_empty() => Ok(text.to_owned()),
            _ => Err(OsIndexError::ExclusionsInvalid),
        })
        .collect()
}

/// `*`-only glob over bytes, ASCII case-insensitive. Iterative with a single backtrack point, so
/// it runs in O(pattern × text) at worst and never recurses.
pub(super) fn glob_matches(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    loop {
        match (pattern.get(p), text.get(t)) {
            (Some(b'*'), _) => {
                star = Some((p, t));
                p += 1;
            }
            (Some(expected), Some(actual)) if expected.eq_ignore_ascii_case(actual) => {
                p += 1;
                t += 1;
            }
            (None, None) => return true,
            _ => match star {
                Some((star_p, star_t)) if star_t < text.len() => {
                    star = Some((star_p, star_t + 1));
                    p = star_p + 1;
                    t = star_t + 1;
                }
                _ => return false,
            },
        }
    }
}
