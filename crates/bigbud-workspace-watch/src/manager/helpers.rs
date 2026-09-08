use std::collections::HashMap;
use std::path::Path;

use super::Interest;
use super::recovery::restore_invalidated;
use crate::backend::WatchBackend;
use crate::events::{Snapshot, emit_rescan, snapshot};
use crate::registry::EventSink;
use crate::{
    WorkspaceRescanReason, WorkspaceWatchBackend, WorkspaceWatchError, WorkspaceWatchHost,
};

pub(crate) fn restore_interests(
    workspace: &dyn WorkspaceWatchHost,
    sink: &EventSink,
    backend: &mut WatchBackend,
    interests: &mut HashMap<String, Interest>,
    generation: &mut u64,
) {
    if restore_invalidated(workspace, backend, interests) {
        *generation = generation.saturating_add(1);
        emit_rescan_all(
            sink,
            interests,
            *generation,
            WorkspaceRescanReason::WatchInvalidated,
            backend.kind(),
        );
    }
}

pub(crate) fn emit_overflow(
    sink: &EventSink,
    interests: &mut HashMap<String, Interest>,
    generation: &mut u64,
    backend: WorkspaceWatchBackend,
) {
    *generation = generation.saturating_add(1);
    emit_rescan_all(
        sink,
        interests,
        *generation,
        WorkspaceRescanReason::Overflow,
        backend,
    );
}

pub(crate) fn emit_rescan_all(
    sink: &EventSink,
    interests: &mut HashMap<String, Interest>,
    generation: u64,
    reason: WorkspaceRescanReason,
    backend: WorkspaceWatchBackend,
) {
    for (subscription_id, interest) in interests {
        interest.sequence = interest.sequence.saturating_add(1);
        emit_rescan(
            sink,
            subscription_id,
            generation,
            interest.sequence,
            reason,
            backend,
        );
    }
}

pub(crate) fn subscribe_interest(
    workspace: &dyn WorkspaceWatchHost,
    backend: &mut WatchBackend,
    interests: &HashMap<String, Interest>,
    relative_path: &str,
    absolute_path: &Path,
) -> Result<(Snapshot, bool), WorkspaceWatchError> {
    if let Some(existing) = interests
        .values()
        .find(|interest| interest.absolute_path == absolute_path && !interest.invalidated)
    {
        return Ok((existing.snapshot.clone(), false));
    }
    if !interests
        .values()
        .any(|interest| interest.absolute_path == absolute_path)
    {
        let existing_paths = interests
            .values()
            .map(|interest| interest.absolute_path.as_path())
            .collect::<Vec<_>>();
        let backend_changed = backend.watch(absolute_path, &existing_paths)?;
        return match snapshot(workspace, relative_path) {
            Ok(snapshot) => Ok((snapshot, backend_changed)),
            Err(error) => {
                let _ = backend.unwatch(absolute_path);
                Err(WorkspaceWatchError::Host(error))
            }
        };
    }
    snapshot(workspace, relative_path)
        .map(|snapshot| (snapshot, false))
        .map_err(WorkspaceWatchError::Host)
}
