use super::DirectoryEntry;

// Keep these scores aligned with WorkspaceEntriesSearch.ts. UTF-16 indices match
// JavaScript's fuzzy penalties, including for paths containing non-BMP characters.
pub(super) fn normalize_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches(['@', '.', '/'])
        .to_lowercase()
}

pub(super) fn score_entry(entry: &DirectoryEntry, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(usize::from(!entry.is_directory));
    }
    let path = entry.path.to_lowercase();
    // rsplit always has an element, even for an empty path.
    let name = path.rsplit('/').next()?;
    if name == query {
        return Some(0);
    }
    if path == query {
        return Some(1);
    }
    if name.starts_with(query) {
        return Some(2);
    }
    if path.starts_with(query) {
        return Some(3);
    }
    if path.contains(&format!("/{query}")) {
        return Some(4);
    }
    if name.contains(query) {
        return Some(5);
    }
    if path.contains(query) {
        return Some(6);
    }
    score_subsequence(name, query)
        .map(|score| 100 + score)
        .or_else(|| score_subsequence(&path, query).map(|score| 200 + score))
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

pub(super) struct RankedEntries {
    entries: Vec<(usize, DirectoryEntry)>,
    limit: usize,
}

impl RankedEntries {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            entries: Vec::new(),
            limit,
        }
    }

    pub(super) fn insert(&mut self, entry: DirectoryEntry, score: usize) {
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

    pub(super) fn into_entries(self) -> Vec<DirectoryEntry> {
        self.entries.into_iter().map(|(_, entry)| entry).collect()
    }
}
