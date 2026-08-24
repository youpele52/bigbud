use crate::backend::{SystemWatchBackendFactory, WatchBackendFactory};
use crate::manager::{ManagerCommand, spawn_manager};
use crate::{WorkspaceWatchError, WorkspaceWatchEvent, WorkspaceWatchHost, WorkspaceWatchStart};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};

pub(crate) type EventSink = Arc<dyn Fn(WorkspaceWatchEvent) + Send + Sync>;
const MANAGER_QUEUE_CAPACITY: usize = 256;
const MAX_WATCH_SUBSCRIPTIONS: usize = 512;
pub(crate) const MAX_WORKSPACE_SUBSCRIPTIONS: usize = 256;

pub struct WorkspaceWatchRegistry {
    state: Mutex<RegistryState>,
    next_generation: AtomicU64,
    sink: EventSink,
    backend_factory: Arc<dyn WatchBackendFactory>,
}

struct RegistryState {
    managers: HashMap<PathBuf, ManagerEntry>,
    subscriptions: HashMap<String, PathBuf>,
}

struct ManagerEntry {
    sender: mpsc::SyncSender<ManagerCommand>,
    subscriptions: usize,
}

impl WorkspaceWatchRegistry {
    pub fn new(sink: impl Fn(WorkspaceWatchEvent) + Send + Sync + 'static) -> Self {
        Self {
            state: Mutex::new(RegistryState {
                managers: HashMap::new(),
                subscriptions: HashMap::new(),
            }),
            next_generation: AtomicU64::new(1),
            sink: Arc::new(sink),
            backend_factory: Arc::new(SystemWatchBackendFactory),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_backend_factory(
        sink: impl Fn(WorkspaceWatchEvent) + Send + Sync + 'static,
        backend_factory: Arc<dyn WatchBackendFactory>,
    ) -> Self {
        Self {
            state: Mutex::new(RegistryState {
                managers: HashMap::new(),
                subscriptions: HashMap::new(),
            }),
            next_generation: AtomicU64::new(1),
            sink: Arc::new(sink),
            backend_factory,
        }
    }

    pub fn subscribe(
        &self,
        subscription_id: &str,
        workspace: Arc<dyn WorkspaceWatchHost>,
        relative_path: &str,
    ) -> Result<WorkspaceWatchStart, WorkspaceWatchError> {
        let absolute_path = workspace.resolve_directory(relative_path)?;
        let root = workspace.canonical_root().to_path_buf();
        let (reply_sender, reply_receiver) = mpsc::channel();
        let mut state = self
            .state
            .lock()
            .map_err(|_| WorkspaceWatchError::WorkerStopped)?;
        if state.subscriptions.contains_key(subscription_id) {
            return Err(WorkspaceWatchError::DuplicateSubscription);
        }
        if state.subscriptions.len() >= MAX_WATCH_SUBSCRIPTIONS {
            return Err(WorkspaceWatchError::ResourceLimit);
        }
        let entry = state.managers.entry(root.clone()).or_insert_with(|| {
            let (sender, receiver) = mpsc::sync_channel(MANAGER_QUEUE_CAPACITY);
            let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
            spawn_manager(
                workspace,
                generation,
                receiver,
                sender.clone(),
                Arc::clone(&self.sink),
                Arc::clone(&self.backend_factory),
            );
            ManagerEntry {
                sender,
                subscriptions: 0,
            }
        });
        if entry.subscriptions >= MAX_WORKSPACE_SUBSCRIPTIONS {
            return Err(WorkspaceWatchError::ResourceLimit);
        }
        entry
            .sender
            .send(ManagerCommand::Subscribe {
                subscription_id: subscription_id.to_owned(),
                relative_path: normalize_path(relative_path),
                absolute_path,
                reply: reply_sender,
            })
            .map_err(|_| WorkspaceWatchError::WorkerStopped)?;
        let result = reply_receiver
            .recv()
            .map_err(|_| WorkspaceWatchError::WorkerStopped)?;
        match result {
            Ok(started) => {
                entry.subscriptions += 1;
                state.subscriptions.insert(subscription_id.to_owned(), root);
                Ok(started)
            }
            Err(error) => {
                if entry.subscriptions == 0 {
                    let _ = entry.sender.send(ManagerCommand::Shutdown);
                    state.managers.remove(&root);
                }
                Err(error)
            }
        }
    }

    pub fn unsubscribe(&self, subscription_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(root) = state.subscriptions.remove(subscription_id) else {
            return false;
        };
        let mut remove_manager = false;
        if let Some(entry) = state.managers.get_mut(&root) {
            let _ = entry
                .sender
                .send(ManagerCommand::Unsubscribe(subscription_id.to_owned()));
            entry.subscriptions = entry.subscriptions.saturating_sub(1);
            remove_manager = entry.subscriptions == 0;
            if remove_manager {
                let _ = entry.sender.send(ManagerCommand::Shutdown);
            }
        }
        if remove_manager {
            state.managers.remove(&root);
        }
        true
    }

    #[cfg(test)]
    fn counts(&self) -> (usize, usize) {
        self.state
            .lock()
            .map(|state| (state.managers.len(), state.subscriptions.len()))
            .unwrap_or_default()
    }
}

fn normalize_path(path: &str) -> String {
    if path == "." {
        String::new()
    } else {
        path.trim_matches('/').to_owned()
    }
}

#[cfg(test)]
#[path = "registry.behavior.tests.rs"]
mod behavior_tests;
#[cfg(test)]
#[path = "registry.race.tests.rs"]
mod race_tests;
#[cfg(test)]
#[path = "registry.recovery.tests.rs"]
mod recovery_tests;
#[cfg(test)]
#[path = "registry.subscription.tests.rs"]
mod subscription_tests;
#[cfg(test)]
#[path = "registry.tests.rs"]
mod tests;
