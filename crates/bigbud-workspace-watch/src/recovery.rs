use std::collections::{HashMap, HashSet};
use std::sync::mpsc;

use crate::backend::{WatchBackend, WatchBackendFactory};
use crate::events::snapshot;
use crate::manager::{Interest, ManagerCommand};
use crate::{WorkspaceWatchBackend, WorkspaceWatchHost};

pub(crate) fn rebuild_backend(
    workspace: &dyn WorkspaceWatchHost,
    factory: &dyn WatchBackendFactory,
    sender: mpsc::SyncSender<ManagerCommand>,
    backend: &mut WatchBackend,
    interests: &mut HashMap<String, Interest>,
) -> Result<WorkspaceWatchBackend, notify::Error> {
    let mut candidate = match factory.create(workspace, sender.clone()) {
        Ok(candidate) => candidate,
        Err(_) => factory.poll(sender.clone())?,
    };
    if register_interests(&mut candidate, interests).is_err() {
        candidate = factory.poll(sender)?;
        register_interests(&mut candidate, interests)?;
    }

    rebaseline_interests(workspace, interests);
    let kind = candidate.kind();
    *backend = candidate;
    Ok(kind)
}

fn register_interests(
    backend: &mut WatchBackend,
    interests: &HashMap<String, Interest>,
) -> notify::Result<()> {
    let mut registered = HashSet::new();
    for path in interests
        .values()
        .map(|interest| interest.absolute_path.as_path())
    {
        if registered.insert(path) {
            let existing = registered
                .iter()
                .copied()
                .filter(|existing| *existing != path)
                .collect::<Vec<_>>();
            backend.watch(path, &existing)?;
        }
    }
    Ok(())
}

fn rebaseline_interests(
    workspace: &dyn WorkspaceWatchHost,
    interests: &mut HashMap<String, Interest>,
) {
    let mut snapshots = HashMap::new();
    for interest in interests.values_mut() {
        let next = snapshots
            .entry(interest.relative_path.clone())
            .or_insert_with(|| snapshot(workspace, &interest.relative_path).ok());
        if let Some(next) = next {
            interest.snapshot = next.clone();
            interest.invalidated = false;
        } else {
            interest.invalidated = true;
        }
    }
}

pub(crate) fn restore_invalidated(
    workspace: &dyn WorkspaceWatchHost,
    backend: &mut WatchBackend,
    interests: &mut HashMap<String, Interest>,
) -> bool {
    let invalidated_paths = interests
        .values()
        .filter(|interest| interest.invalidated)
        .map(|interest| interest.absolute_path.clone())
        .collect::<HashSet<_>>();
    let mut restored = false;

    for invalidated_path in invalidated_paths {
        let Some(relative_path) = interests
            .values()
            .find(|interest| interest.absolute_path == invalidated_path)
            .map(|interest| interest.relative_path.clone())
        else {
            continue;
        };
        let Ok(absolute_path) = workspace.resolve_directory(&relative_path) else {
            continue;
        };
        let existing_paths = interests
            .values()
            .filter(|interest| !interest.invalidated)
            .map(|interest| interest.absolute_path.as_path())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if backend.watch(&absolute_path, &existing_paths).is_err() {
            continue;
        }
        let Ok(next) = snapshot(workspace, &relative_path) else {
            let _ = backend.unwatch(&absolute_path);
            continue;
        };
        for interest in interests
            .values_mut()
            .filter(|interest| interest.absolute_path == invalidated_path)
        {
            interest.absolute_path = absolute_path.clone();
            interest.snapshot = next.clone();
            interest.invalidated = false;
            restored = true;
        }
    }

    restored
}
