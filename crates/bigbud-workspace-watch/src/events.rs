use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use notify::{Event, EventKind};

use crate::manager::Interest;
use crate::registry::EventSink;
use crate::{
    WorkspaceChange, WorkspaceChangeKind, WorkspaceRescanReason, WorkspaceWatchBackend,
    WorkspaceWatchEntry, WorkspaceWatchEvent, WorkspaceWatchHost, WorkspaceWatchHostError,
};

const MAX_CHANGED_PATHS: usize = 256;
const MAX_CHANGED_BYTES: usize = 128 * 1024;

pub(crate) type Snapshot = BTreeMap<String, EntryFingerprint>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryFingerprint {
    is_directory: bool,
    is_file: bool,
    size_bytes: u64,
    modified_unix_ms: u64,
}

pub(crate) fn reconcile_events(
    workspace: &dyn WorkspaceWatchHost,
    sink: &EventSink,
    interests: &mut HashMap<String, Interest>,
    generation: u64,
    backend: WorkspaceWatchBackend,
    events: Vec<Event>,
) -> Vec<PathBuf> {
    let mut hinted = BTreeMap::new();
    for event in events {
        let kind = event_kind(&event.kind);
        for path in event.paths {
            if let Ok(path) = workspace.relative_path(&path) {
                hinted.insert(path, kind);
            }
        }
    }
    let mut snapshots = HashMap::<String, Option<Snapshot>>::new();
    let mut invalidated_paths = Vec::new();
    for (subscription_id, interest) in interests {
        let relevant_hints = hinted
            .iter()
            .filter(|(path, _)| direct_child_or_self(path, &interest.relative_path))
            .map(|(path, kind)| (path.clone(), *kind))
            .collect::<Vec<_>>();
        if relevant_hints.is_empty() || interest.invalidated {
            continue;
        }
        let next = snapshots
            .entry(interest.relative_path.clone())
            .or_insert_with(|| snapshot(workspace, &interest.relative_path).ok())
            .clone();
        match next {
            Some(next) => {
                let mut changes = snapshot_changes(&interest.snapshot, &next);
                let directory_hint = relevant_hints
                    .iter()
                    .any(|(path, _)| path == &interest.relative_path);
                for (path, kind) in relevant_hints {
                    if path != interest.relative_path {
                        changes.entry(path).or_insert(kind);
                    }
                }
                interest.snapshot = next;
                interest.sequence = interest.sequence.saturating_add(1);
                if changes.is_empty() && directory_hint {
                    emit_rescan(
                        sink,
                        subscription_id,
                        generation,
                        interest.sequence,
                        WorkspaceRescanReason::WatchInvalidated,
                        backend,
                    );
                    continue;
                }
                let changed_bytes = changes
                    .iter()
                    .map(|(path, kind)| path.len().saturating_add(kind.as_str().len()))
                    .sum::<usize>();
                if changes.len() > MAX_CHANGED_PATHS || changed_bytes > MAX_CHANGED_BYTES {
                    emit_rescan(
                        sink,
                        subscription_id,
                        generation,
                        interest.sequence,
                        WorkspaceRescanReason::Overflow,
                        backend,
                    );
                } else {
                    emit_changes(
                        sink,
                        subscription_id,
                        generation,
                        interest.sequence,
                        changes,
                        backend,
                    );
                }
            }
            None => {
                interest.sequence = interest.sequence.saturating_add(1);
                interest.invalidated = true;
                if !invalidated_paths.contains(&interest.absolute_path) {
                    invalidated_paths.push(interest.absolute_path.clone());
                }
                emit_rescan(
                    sink,
                    subscription_id,
                    generation,
                    interest.sequence,
                    WorkspaceRescanReason::WatchInvalidated,
                    backend,
                );
            }
        }
    }
    invalidated_paths
}

pub(crate) fn snapshot(
    workspace: &dyn WorkspaceWatchHost,
    relative_path: &str,
) -> Result<Snapshot, WorkspaceWatchHostError> {
    workspace.list_directory(relative_path).map(|entries| {
        entries
            .into_iter()
            .map(|entry| (entry.path.clone(), EntryFingerprint::from(entry)))
            .collect()
    })
}

fn snapshot_changes(previous: &Snapshot, next: &Snapshot) -> BTreeMap<String, WorkspaceChangeKind> {
    let mut changes = BTreeMap::new();
    for (path, fingerprint) in next {
        match previous.get(path) {
            None => {
                changes.insert(path.clone(), WorkspaceChangeKind::Create);
            }
            Some(previous) if previous != fingerprint => {
                changes.insert(path.clone(), WorkspaceChangeKind::Modify);
            }
            _ => {}
        }
    }
    for path in previous.keys() {
        if !next.contains_key(path) {
            changes.insert(path.clone(), WorkspaceChangeKind::Remove);
        }
    }
    changes
}

fn emit_changes(
    sink: &EventSink,
    subscription_id: &str,
    generation: u64,
    sequence: u64,
    changes: BTreeMap<String, WorkspaceChangeKind>,
    backend: WorkspaceWatchBackend,
) {
    if changes.is_empty() {
        return;
    }
    sink(WorkspaceWatchEvent {
        subscription_id: subscription_id.to_owned(),
        generation,
        sequence,
        changes: changes
            .into_iter()
            .map(|(path, kind)| WorkspaceChange { path, kind })
            .collect(),
        rescan_reason: None,
        backend,
    });
}

pub(crate) fn emit_rescan(
    sink: &EventSink,
    subscription_id: &str,
    generation: u64,
    sequence: u64,
    reason: WorkspaceRescanReason,
    backend: WorkspaceWatchBackend,
) {
    sink(WorkspaceWatchEvent {
        subscription_id: subscription_id.to_owned(),
        generation,
        sequence,
        changes: Vec::new(),
        rescan_reason: Some(reason),
        backend,
    });
}

fn direct_child_or_self(path: &str, directory: &str) -> bool {
    let path = Path::new(path);
    let directory = Path::new(directory);
    path == directory || path.parent() == Some(directory)
}

fn event_kind(kind: &EventKind) -> WorkspaceChangeKind {
    match kind {
        EventKind::Create(_) => WorkspaceChangeKind::Create,
        EventKind::Remove(_) => WorkspaceChangeKind::Remove,
        EventKind::Modify(_) => WorkspaceChangeKind::Modify,
        _ => WorkspaceChangeKind::Unknown,
    }
}

impl From<WorkspaceWatchEntry> for EntryFingerprint {
    fn from(entry: WorkspaceWatchEntry) -> Self {
        Self {
            is_directory: entry.is_directory,
            is_file: entry.is_file,
            size_bytes: entry.size_bytes,
            modified_unix_ms: entry.modified_unix_ms,
        }
    }
}
