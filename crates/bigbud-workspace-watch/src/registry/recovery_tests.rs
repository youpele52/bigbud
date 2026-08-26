use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};

use notify::{Config, Event, EventHandler, EventKind, RecursiveMode, Watcher, WatcherKind};

use super::tests::{receive_event, temporary_workspace, workspace};
use super::{ManagerCommand, WorkspaceWatchRegistry};
use crate::backend::{WatchBackend, WatchBackendFactory};
use crate::{WorkspaceRescanReason, WorkspaceWatchBackend};

enum BackendAction {
    Ready(WorkspaceWatchBackend),
    WatchFail(WorkspaceWatchBackend, notify::ErrorKind),
    Fail(notify::ErrorKind),
}

struct ScriptedBackendFactory {
    create: Mutex<VecDeque<BackendAction>>,
    poll: Mutex<VecDeque<BackendAction>>,
}

impl ScriptedBackendFactory {
    fn new(create: Vec<BackendAction>, poll: Vec<BackendAction>) -> Arc<Self> {
        Arc::new(Self {
            create: Mutex::new(create.into()),
            poll: Mutex::new(poll.into()),
        })
    }

    fn next(
        queue: &Mutex<VecDeque<BackendAction>>,
        sender: mpsc::SyncSender<ManagerCommand>,
    ) -> notify::Result<WatchBackend> {
        match queue.lock().unwrap().pop_front().expect("scripted backend") {
            BackendAction::Ready(kind) => Ok(WatchBackend::injected(
                Box::new(InjectedWatcher { failure: None }),
                kind,
                sender,
                false,
            )),
            BackendAction::WatchFail(kind, failure) => Ok(WatchBackend::injected(
                Box::new(InjectedWatcher {
                    failure: Some(failure),
                }),
                kind,
                sender,
                false,
            )),
            BackendAction::Fail(kind) => Err(notify::Error::new(kind)),
        }
    }
}

impl WatchBackendFactory for ScriptedBackendFactory {
    fn create(
        &self,
        _workspace: &dyn crate::WorkspaceWatchHost,
        sender: mpsc::SyncSender<ManagerCommand>,
    ) -> notify::Result<WatchBackend> {
        Self::next(&self.create, sender)
    }

    fn poll(&self, sender: mpsc::SyncSender<ManagerCommand>) -> notify::Result<WatchBackend> {
        Self::next(&self.poll, sender)
    }
}

struct InjectedWatcher {
    failure: Option<notify::ErrorKind>,
}

impl Watcher for InjectedWatcher {
    fn new<F: EventHandler>(_event_handler: F, _config: Config) -> notify::Result<Self> {
        Ok(Self { failure: None })
    }

    fn watch(&mut self, _path: &Path, _recursive_mode: RecursiveMode) -> notify::Result<()> {
        match self.failure.take() {
            Some(kind) => Err(notify::Error::new(kind)),
            None => Ok(()),
        }
    }

    fn unwatch(&mut self, _path: &Path) -> notify::Result<()> {
        Ok(())
    }

    fn kind() -> WatcherKind {
        WatcherKind::NullWatcher
    }
}

fn manager_sender(registry: &WorkspaceWatchRegistry) -> mpsc::SyncSender<ManagerCommand> {
    registry
        .state
        .lock()
        .unwrap()
        .managers
        .values()
        .next()
        .unwrap()
        .sender
        .clone()
}

fn inject_exact_change(sender: &mpsc::SyncSender<ManagerCommand>, root: &Path, name: &str) {
    fs::write(root.join(name), "changed").unwrap();
    let canonical_path = fs::canonicalize(root).unwrap().join(name);
    sender
        .send(ManagerCommand::FileSystem(Ok(Event::new(
            EventKind::Modify(notify::event::ModifyKind::Any),
        )
        .add_path(canonical_path))))
        .unwrap();
}

#[test]
fn runtime_backend_failure_rebuilds_and_later_delivers_exact_events() {
    let root = temporary_workspace("runtime-rebuild");
    let factory = ScriptedBackendFactory::new(
        vec![
            BackendAction::Ready(WorkspaceWatchBackend::Native),
            BackendAction::Ready(WorkspaceWatchBackend::Native),
        ],
        vec![],
    );
    let (event_sender, event_receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::with_backend_factory(
        move |event| {
            let _ = event_sender.send(event);
        },
        factory,
    );
    let started = registry.subscribe("root", workspace(&root), "").unwrap();
    let manager = manager_sender(&registry);
    manager
        .send(ManagerCommand::FileSystem(Err(notify::Error::generic(
            "backend stopped",
        ))))
        .unwrap();

    let invalidated = receive_event(&event_receiver, |event| {
        event.rescan_reason == Some(WorkspaceRescanReason::WatchInvalidated)
            && event.generation > started.generation
    });
    let recovered = receive_event(&event_receiver, |event| {
        event.rescan_reason == Some(WorkspaceRescanReason::WatchInvalidated)
            && event.generation > invalidated.generation
    });
    assert_eq!(recovered.backend, WorkspaceWatchBackend::Native);

    inject_exact_change(&manager, &root, "after-recovery.txt");
    let exact = receive_event(&event_receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "after-recovery.txt")
    });
    assert_eq!(exact.backend, WorkspaceWatchBackend::Native);

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_native_restoration_transitions_to_rust_polling() {
    let root = temporary_workspace("poll-fallback");
    let factory = ScriptedBackendFactory::new(
        vec![
            BackendAction::Ready(WorkspaceWatchBackend::Native),
            BackendAction::WatchFail(
                WorkspaceWatchBackend::Native,
                notify::ErrorKind::MaxFilesWatch,
            ),
        ],
        vec![BackendAction::Ready(WorkspaceWatchBackend::Poll)],
    );
    let (event_sender, event_receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::with_backend_factory(
        move |event| {
            let _ = event_sender.send(event);
        },
        factory,
    );
    registry.subscribe("root", workspace(&root), "").unwrap();
    let manager = manager_sender(&registry);
    manager
        .send(ManagerCommand::FileSystem(Err(notify::Error::new(
            notify::ErrorKind::MaxFilesWatch,
        ))))
        .unwrap();

    let fallback = receive_event(&event_receiver, |event| {
        event.rescan_reason == Some(WorkspaceRescanReason::WatchInvalidated)
            && event.backend == WorkspaceWatchBackend::Poll
    });
    assert_eq!(fallback.backend, WorkspaceWatchBackend::Poll);

    inject_exact_change(&manager, &root, "after-poll-fallback.txt");
    let exact = receive_event(&event_receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "after-poll-fallback.txt")
    });
    assert_eq!(exact.backend, WorkspaceWatchBackend::Poll);

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_reconstruction_retries_with_backoff_and_recovers() {
    let root = temporary_workspace("recovery-retry");
    let factory = ScriptedBackendFactory::new(
        vec![
            BackendAction::Ready(WorkspaceWatchBackend::Native),
            BackendAction::Fail(notify::ErrorKind::Generic("native failed".to_owned())),
            BackendAction::Ready(WorkspaceWatchBackend::Native),
        ],
        vec![BackendAction::Fail(notify::ErrorKind::Generic(
            "poll failed".to_owned(),
        ))],
    );
    let (event_sender, event_receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::with_backend_factory(
        move |event| {
            let _ = event_sender.send(event);
        },
        factory,
    );
    registry.subscribe("root", workspace(&root), "").unwrap();
    let manager = manager_sender(&registry);
    manager
        .send(ManagerCommand::FileSystem(Err(notify::Error::generic(
            "backend stopped",
        ))))
        .unwrap();
    let first = receive_event(&event_receiver, |event| event.rescan_reason.is_some());
    let recovered = receive_event(&event_receiver, |event| {
        event.generation > first.generation
            && event.backend == WorkspaceWatchBackend::Native
            && event.rescan_reason == Some(WorkspaceRescanReason::WatchInvalidated)
    });
    assert!(recovered.generation > first.generation);

    inject_exact_change(&manager, &root, "after-retry.txt");
    receive_event(&event_receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "after-retry.txt")
    });

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_watch_exhaustion_uses_the_injected_poll_fallback() {
    failed_native_restoration_transitions_to_rust_polling();
}
