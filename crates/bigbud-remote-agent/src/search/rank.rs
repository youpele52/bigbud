use crate::workspace::DirectoryEntry;

#[cfg(test)]
#[path = "rank.tests.rs"]
mod tests;

// Keep these scores aligned with `packages/shared/src/search/nameRank.ts` (Mod+P's local list);
// `nameRank.fixtures.json` is run by both test suites. UTF-16 indices match JavaScript's fuzzy
// penalties, including for paths containing non-BMP characters.

/// A normalized name query. Every comparison uses `folded`, so case never filters a match;
/// `exact` (the same text before lowercasing) only earns the exact-case bonus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NameQuery {
    exact: String,
    folded: String,
}

impl NameQuery {
    pub(crate) fn is_empty(&self) -> bool {
        self.folded.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn folded(&self) -> &str {
        &self.folded
    }
}

pub(crate) fn normalize_query(query: &str) -> NameQuery {
    let exact = query
        .trim_matches(is_javascript_trim_whitespace)
        .trim_start_matches(['@', '.', '/'])
        .to_owned();
    let folded = exact.to_lowercase();
    NameQuery { exact, folded }
}

/// The characters JavaScript's `String.prototype.trim` removes: Unicode `Zs` spaces, the ASCII
/// controls `\t` to `\r`, the line and paragraph separators and the byte-order mark. Unlike
/// `char::is_whitespace`, NEL (U+0085) is kept.
fn is_javascript_trim_whitespace(character: char) -> bool {
    let space = matches!(character, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}');
    let separator = matches!(character, '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}');
    let other = matches!(character, '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    space || separator || other
}

/// Lower scores are better. Substring classes score `2 * class`, plus one when the match only
/// holds case-insensitively (the exact-case bonus); fuzzy matches score 100+ (name) or 200+
/// (path) and ignore case entirely.
pub(crate) fn score_entry(entry: &DirectoryEntry, query: &NameQuery) -> Option<usize> {
    if query.is_empty() {
        return Some(usize::from(!entry.is_directory));
    }
    let path = entry.path.to_lowercase();
    // rsplit always has an element, even for an empty path.
    let name = path.rsplit('/').next()?;
    if let Some(class) = substring_class(name, &path, &query.folded) {
        let exact_name = entry.path.rsplit('/').next()?;
        let exact_case = substring_class(exact_name, &entry.path, &query.exact)
            .is_some_and(|exact_class| exact_class <= class);
        return Some(class * 2 + usize::from(!exact_case));
    }
    score_subsequence(name, &query.folded)
        .map(|score| 100 + score)
        .or_else(|| score_subsequence(&path, &query.folded).map(|score| 200 + score))
}

/// Exact name, exact path, name prefix, path prefix, segment prefix, name substring, then path
/// substring (0 to 6), compared exactly as given.
fn substring_class(name: &str, path: &str, query: &str) -> Option<usize> {
    if name == query {
        Some(0)
    } else if path == query {
        Some(1)
    } else if name.starts_with(query) {
        Some(2)
    } else if path.starts_with(query) {
        Some(3)
    } else if path.contains(&format!("/{query}")) {
        Some(4)
    } else if name.contains(query) {
        Some(5)
    } else if path.contains(query) {
        Some(6)
    } else {
        None
    }
}

fn score_subsequence(value: &str, query: &str) -> Option<usize> {
    let mut query_units = query.encode_utf16();
    let mut next = query_units.next()?;
    let mut first = None;
    let mut previous = None;
    let mut gaps = 0;
    for (index, unit) in value.encode_utf16().enumerate() {
        if unit != next {
            continue;
        }
        let first = *first.get_or_insert(index);
        if let Some(previous) = previous {
            gaps += index - previous - 1;
        }
        previous = Some(index);
        match query_units.next() {
            Some(unit) => next = unit,
            None => {
                let query_len = query.encode_utf16().count();
                let span = index - first + 1 - query_len;
                let length = (value.encode_utf16().count() - query_len).min(64);
                return Some(first * 2 + gaps * 3 + span + length);
            }
        }
    }
    None
}

pub(crate) struct RankedEntries {
    entries: Vec<(usize, DirectoryEntry)>,
    limit: usize,
}

impl RankedEntries {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            entries: Vec::new(),
            limit,
        }
    }

    pub(crate) fn insert(&mut self, entry: DirectoryEntry, score: usize) {
        let index = self.entries.partition_point(|(current_score, current)| {
            (*current_score, &current.path) <= (score, &entry.path)
        });
        if index >= self.limit {
            return;
        }
        // Remove the worst before inserting, so retained candidates never exceed
        // the limit. Tie-break by original path for deterministic remote results.
        if self.entries.len() == self.limit {
            let _removed = self.entries.pop();
        }
        self.entries.insert(index, (score, entry));
    }

    pub(crate) fn into_entries(self) -> Vec<DirectoryEntry> {
        self.entries.into_iter().map(|(_, entry)| entry).collect()
    }

    /// Best first, with the score kept for the wire (`WorkspaceSearchNameHit.score`).
    pub(crate) fn into_scored_entries(self) -> Vec<(usize, DirectoryEntry)> {
        self.entries
    }
}
