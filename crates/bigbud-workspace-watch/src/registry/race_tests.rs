use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use super::WorkspaceWatchRegistry;
use super::tests::{TestWorkspace, receive_event, temporary_workspace};
use crate::{WorkspaceWatchEntry, WorkspaceWatchHost, WorkspaceWatchHostError};

struct BlockingBaselineWorkspace {
    inner: TestWorkspace,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    first_list: AtomicBool,
}

impl WorkspaceWatchHost for BlockingBaselineWorkspace {
    fn canonical_root(&self) -> &Path {
        self.inner.canonical_root()
    }

    fn resolve_directory(&self, relative_path: &str) -> Result<PathBuf, WorkspaceWatchHostError> {
        self.inner.resolve_directory(relative_path)
    }

    fn relative_path(&self, path: &Path) -> Result<String, WorkspaceWatchHostError> {
        self.inner.relative_path(path)
    }

    fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<Vec<WorkspaceWatchEntry>, WorkspaceWatchHostError> {
        if self.first_list.swap(false, Ordering::Relaxed) {
            let _ = self.entered.send(());
            let _ = self.release.lock().unwrap().recv();
        }
        self.inner.list_directory(relative_path)
    }
}

#[test]
fn change_during_initial_baseline_is_delivered_after_subscription_starts() {
    let root = temporary_workspace("initial-race");
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let workspace = Arc::new(BlockingBaselineWorkspace {
        inner: TestWorkspace::open(&root),
        entered: entered_sender,
        release: Mutex::new(release_receiver),
        first_list: AtomicBool::new(true),
    });
    let (event_sender, event_receiver) = mpsc::channel();
    let registry = Arc::new(WorkspaceWatchRegistry::new(move |event| {
        let _ = event_sender.send(event);
    }));
    let subscribe_registry = Arc::clone(&registry);
    let subscribe =
        std::thread::spawn(move || subscribe_registry.subscribe("root", workspace, "").unwrap());

    entered_receiver.recv().unwrap();
    fs::write(root.join("during-baseline.txt"), "changed").unwrap();
    release_sender.send(()).unwrap();

    let started = subscribe.join().unwrap();
    let exact = receive_event(&event_receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "during-baseline.txt")
    });
    assert_eq!(exact.generation, started.generation);

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}
