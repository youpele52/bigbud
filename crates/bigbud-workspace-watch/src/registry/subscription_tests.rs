use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};

use notify::{Config, EventHandler, RecursiveMode, Watcher, WatcherKind};

use super::tests::temporary_workspace;
use crate::backend::WatchBackend;
use crate::manager::ManagerCommand;
use crate::manager::helpers::subscribe_interest;
use crate::{
    WorkspaceWatchBackend, WorkspaceWatchEntry, WorkspaceWatchError, WorkspaceWatchHost,
    WorkspaceWatchHostError,
};

struct FailingSnapshotWorkspace {
    root: PathBuf,
}

impl WorkspaceWatchHost for FailingSnapshotWorkspace {
    fn canonical_root(&self) -> &Path {
        &self.root
    }

    fn resolve_directory(&self, _relative_path: &str) -> Result<PathBuf, WorkspaceWatchHostError> {
        Ok(self.root.clone())
    }

    fn relative_path(&self, _path: &Path) -> Result<String, WorkspaceWatchHostError> {
        Ok(String::new())
    }

    fn list_directory(
        &self,
        _relative_path: &str,
    ) -> Result<Vec<WorkspaceWatchEntry>, WorkspaceWatchHostError> {
        Err(WorkspaceWatchHostError::new("injected snapshot failure"))
    }
}

struct TrackingWatcher {
    watched: Arc<Mutex<Vec<PathBuf>>>,
    unwatched: Arc<Mutex<Vec<PathBuf>>>,
}

impl Watcher for TrackingWatcher {
    fn new<F: EventHandler>(_event_handler: F, _config: Config) -> notify::Result<Self> {
        unreachable!("the test injects this watcher")
    }

    fn watch(&mut self, path: &Path, _mode: RecursiveMode) -> notify::Result<()> {
        self.watched.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.unwatched.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }

    fn kind() -> WatcherKind {
        WatcherKind::NullWatcher
    }
}

#[test]
fn snapshot_failure_rolls_back_only_the_new_backend_watch() {
    let root = temporary_workspace("subscribe-rollback");
    let root = std::fs::canonicalize(root).unwrap();
    let watched = Arc::new(Mutex::new(Vec::new()));
    let unwatched = Arc::new(Mutex::new(Vec::new()));
    let (sender, _receiver) = mpsc::sync_channel::<ManagerCommand>(1);
    let mut backend = WatchBackend::injected(
        Box::new(TrackingWatcher {
            watched: Arc::clone(&watched),
            unwatched: Arc::clone(&unwatched),
        }),
        WorkspaceWatchBackend::Native,
        sender,
        false,
    );
    let workspace = FailingSnapshotWorkspace { root: root.clone() };

    let result = subscribe_interest(&workspace, &mut backend, &HashMap::new(), "", &root);

    assert!(matches!(result, Err(WorkspaceWatchError::Host(_))));
    assert_eq!(*watched.lock().unwrap(), vec![root.clone()]);
    assert_eq!(*unwatched.lock().unwrap(), vec![root.clone()]);
    let _ = std::fs::remove_dir(root);
}
