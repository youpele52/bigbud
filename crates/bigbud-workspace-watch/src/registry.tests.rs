use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, UNIX_EPOCH};

use notify::{Event, EventKind};

use super::{MAX_WORKSPACE_SUBSCRIPTIONS, WorkspaceWatchRegistry};
use crate::backend::WatchBackend;
use crate::events::{reconcile_events, snapshot};
use crate::manager::{Interest, ManagerCommand};
use crate::{
    WorkspaceRescanReason, WorkspaceWatchBackend, WorkspaceWatchEntry, WorkspaceWatchError,
    WorkspaceWatchEvent, WorkspaceWatchHost, WorkspaceWatchHostError,
};

#[derive(Debug)]
pub(super) struct TestWorkspace {
    root: PathBuf,
    list_calls: AtomicUsize,
}

impl TestWorkspace {
    pub(super) fn open(root: &Path) -> Self {
        Self {
            root: fs::canonicalize(root).unwrap(),
            list_calls: AtomicUsize::new(0),
        }
    }

    fn list_calls(&self) -> usize {
        self.list_calls.load(Ordering::Relaxed)
    }
}

impl WorkspaceWatchHost for TestWorkspace {
    fn canonical_root(&self) -> &Path {
        &self.root
    }

    fn resolve_directory(&self, relative_path: &str) -> Result<PathBuf, WorkspaceWatchHostError> {
        let path = fs::canonicalize(self.root.join(relative_path)).map_err(host_error)?;
        if !path.starts_with(&self.root) || !path.is_dir() {
            return Err(WorkspaceWatchHostError::new("invalid directory"));
        }
        Ok(path)
    }

    fn relative_path(&self, path: &Path) -> Result<String, WorkspaceWatchHostError> {
        path.strip_prefix(&self.root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(|error| WorkspaceWatchHostError::new(error.to_string()))
    }

    fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<Vec<WorkspaceWatchEntry>, WorkspaceWatchHostError> {
        self.list_calls.fetch_add(1, Ordering::Relaxed);
        let directory = self.resolve_directory(relative_path)?;
        let mut entries = fs::read_dir(directory)
            .map_err(host_error)?
            .map(|entry| {
                let entry = entry.map_err(host_error)?;
                let metadata = entry.metadata().map_err(host_error)?;
                Ok(WorkspaceWatchEntry {
                    path: self.relative_path(&entry.path())?,
                    is_directory: metadata.is_dir(),
                    is_file: metadata.is_file(),
                    size_bytes: metadata.len(),
                    modified_unix_ms: metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                        .map(|value| value.as_millis() as u64)
                        .unwrap_or_default(),
                })
            })
            .collect::<Result<Vec<_>, WorkspaceWatchHostError>>()?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }
}

fn host_error(error: std::io::Error) -> WorkspaceWatchHostError {
    WorkspaceWatchHostError::new(error.to_string())
}

pub(super) fn temporary_workspace(name: &str) -> PathBuf {
    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);
    loop {
        let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "bigbud-watch-{name}-{}-{suffix}",
            std::process::id()
        ));
        match fs::create_dir(&root) {
            Ok(()) => return root,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("failed to create test workspace: {error}"),
        }
    }
}

pub(super) fn workspace(root: &Path) -> Arc<TestWorkspace> {
    Arc::new(TestWorkspace::open(root))
}

#[test]
fn shares_one_manager_for_subscriptions_in_the_same_workspace() {
    let root = temporary_workspace("shared");
    fs::create_dir(root.join("docs")).unwrap();
    let workspace = workspace(&root);
    let registry = WorkspaceWatchRegistry::new(|_| {});

    registry.subscribe("root", workspace.clone(), "").unwrap();
    registry
        .subscribe("docs", workspace.clone(), "docs")
        .unwrap();
    assert_eq!(registry.counts(), (1, 2));

    assert!(registry.unsubscribe("root"));
    assert_eq!(registry.counts(), (1, 1));
    assert!(registry.unsubscribe("docs"));
    assert_eq!(registry.counts(), (0, 0));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_idle_mode_does_not_repeat_directory_snapshots() {
    let root = temporary_workspace("idle");
    let workspace = workspace(&root);
    let registry = WorkspaceWatchRegistry::new(|_| {});
    registry.subscribe("root", workspace.clone(), "").unwrap();
    let baseline_calls = workspace.list_calls();
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(workspace.list_calls(), baseline_calls);
    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn identical_interests_receive_events_and_cleanup_independently() {
    let root = temporary_workspace("duplicate");
    let workspace = workspace(&root);
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });
    registry
        .subscribe("client-a", workspace.clone(), "")
        .unwrap();
    let baseline_calls = workspace.list_calls();
    registry
        .subscribe("client-b", workspace.clone(), "")
        .unwrap();
    assert_eq!(workspace.list_calls(), baseline_calls);
    fs::write(root.join("shared.txt"), "ready").unwrap();
    let first = receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "shared.txt")
    });
    let second = receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "shared.txt")
    });
    let subscribers = [first.subscription_id, second.subscription_id]
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        subscribers,
        std::collections::HashSet::from(["client-a".to_owned(), "client-b".to_owned()])
    );
    assert!(registry.unsubscribe("client-a"));
    assert_eq!(registry.counts(), (1, 1));
    assert!(registry.unsubscribe("client-b"));
    assert_eq!(registry.counts(), (0, 0));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_subscriptions_beyond_the_workspace_limit_without_another_manager() {
    let root = temporary_workspace("limit");
    let workspace = workspace(&root);
    let registry = WorkspaceWatchRegistry::new(|_| {});
    let subscription_ids = (0..MAX_WORKSPACE_SUBSCRIPTIONS)
        .map(|index| format!("watch-{index}"))
        .collect::<Vec<_>>();
    for subscription_id in &subscription_ids {
        registry
            .subscribe(subscription_id, workspace.clone(), "")
            .unwrap();
    }

    let error = registry
        .subscribe("over-limit", workspace, "")
        .expect_err("the workspace limit must be enforced");
    assert!(matches!(error, WorkspaceWatchError::ResourceLimit));
    assert_eq!(error.code(), "RESOURCE_LIMIT");
    assert_eq!(registry.counts(), (1, MAX_WORKSPACE_SUBSCRIPTIONS));

    for subscription_id in subscription_ids {
        registry.unsubscribe(&subscription_id);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn emits_the_exact_changed_path_after_the_baseline_is_ready() {
    let root = temporary_workspace("event");
    fs::write(root.join("watched.txt"), "first").unwrap();
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });

    let started = registry.subscribe("preview", workspace(&root), "").unwrap();
    assert!(started.generation > 0);
    fs::write(root.join("watched.txt"), "other").unwrap();

    let event = receive_event(&receiver, |event| {
        event.subscription_id == "preview"
            && event
                .changes
                .iter()
                .any(|change| change.path == "watched.txt")
    });
    assert_eq!(event.generation, started.generation);
    assert!(event.sequence > 0);

    registry.unsubscribe("preview");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn overflow_changes_generation_and_collapses_to_a_rescan() {
    let root = temporary_workspace("overflow");
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });
    let started = registry.subscribe("root", workspace(&root), "").unwrap();
    let manager = registry
        .state
        .lock()
        .unwrap()
        .managers
        .values()
        .next()
        .unwrap()
        .sender
        .clone();
    manager.send(ManagerCommand::Overflow).unwrap();

    let event = receive_event(&receiver, |event| event.subscription_id == "root");
    assert_eq!(event.rescan_reason, Some(WorkspaceRescanReason::Overflow));
    assert!(event.generation > started.generation);
    assert_eq!(event.sequence, 1);

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn restores_a_watch_after_the_directory_is_recreated() {
    let root = temporary_workspace("restore");
    fs::create_dir(root.join("docs")).unwrap();
    let workspace = workspace(&root);
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });

    registry.subscribe("root", workspace.clone(), "").unwrap();
    registry.subscribe("docs", workspace, "docs").unwrap();
    fs::remove_dir(root.join("docs")).unwrap();

    let invalidated = receive_event(&receiver, |event| {
        event.subscription_id == "docs" && event.rescan_reason.is_some()
    });
    fs::create_dir(root.join("docs")).unwrap();
    let restored = receive_event(&receiver, |event| {
        event.subscription_id == "docs"
            && event.rescan_reason.is_some()
            && event.generation > invalidated.generation
    });
    assert!(restored.generation > invalidated.generation);

    fs::write(root.join("docs/recreated.txt"), "ready").unwrap();
    receive_event(&receiver, |event| {
        event.subscription_id == "docs"
            && event
                .changes
                .iter()
                .any(|change| change.path == "docs/recreated.txt")
    });

    registry.unsubscribe("docs");
    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn requests_a_rescan_for_an_ambiguous_directory_level_event() {
    let root = temporary_workspace("ambiguous");
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("docs/watched.txt"), "first").unwrap();
    let workspace = workspace(&root);
    let (sender, receiver) = mpsc::channel();
    let sink: super::EventSink = Arc::new(move |event| {
        let _ = sender.send(event);
    });
    let mut interests = HashMap::from([(
        "docs".to_owned(),
        Interest {
            relative_path: "docs".to_owned(),
            absolute_path: workspace.canonical_root().join("docs"),
            snapshot: snapshot(workspace.as_ref(), "docs").unwrap(),
            sequence: 0,
            invalidated: false,
        },
    )]);

    let invalidated = reconcile_events(
        workspace.as_ref(),
        &sink,
        &mut interests,
        1,
        WorkspaceWatchBackend::Native,
        vec![Event::new(EventKind::Any).add_path(workspace.canonical_root().join("docs"))],
    );
    assert!(invalidated.is_empty());
    let event = receive_event(&receiver, |event| event.subscription_id == "docs");
    assert_eq!(
        event.rescan_reason,
        Some(WorkspaceRescanReason::WatchInvalidated)
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn polling_backend_detects_file_content_changes() {
    let root = temporary_workspace("poll");
    let workspace = workspace(&root);
    let (sender, receiver) = mpsc::sync_channel(16);
    let mut backend = WatchBackend::poll(sender).unwrap();
    backend.watch(workspace.canonical_root(), &[]).unwrap();
    fs::write(root.join("polled.txt"), "ready").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut detected = false;
    while std::time::Instant::now() < deadline {
        let Ok(command) = receiver.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        if let ManagerCommand::FileSystem(Ok(event)) = command
            && event.paths.iter().any(|path| path.ends_with("polled.txt"))
        {
            detected = true;
            break;
        }
    }
    assert!(detected, "expected polling to detect polled.txt");

    let _ = fs::remove_dir_all(root);
}

pub(super) fn receive_event(
    receiver: &mpsc::Receiver<WorkspaceWatchEvent>,
    matches: impl Fn(&WorkspaceWatchEvent) -> bool,
) -> WorkspaceWatchEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        if matches(&event) {
            return event;
        }
    }
    panic!("expected matching workspace watch event");
}
