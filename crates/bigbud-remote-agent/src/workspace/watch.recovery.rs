use std::collections::{HashMap, HashSet};

use super::backend::WatchBackend;
use super::events::snapshot;
use super::{Interest, WorkspaceRoot};

pub(super) fn restore_invalidated(
    workspace: &WorkspaceRoot,
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
