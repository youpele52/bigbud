use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use bigbud_protocol::v1;
use notify::Event;

use super::WorkspaceRoot;

#[path = "watch.backend.rs"]
mod backend;
#[path = "watch.error.rs"]
mod error;
#[path = "watch.events.rs"]
mod events;
#[path = "watch.recovery.rs"]
mod recovery;
#[cfg(test)]
#[path = "watch.tests.rs"]
mod tests;

use backend::WatchBackend;
pub use error::WorkspaceWatchError;
use events::{emit_rescan, reconcile_events, snapshot};
use recovery::restore_invalidated;

type EventSink = Arc<dyn Fn(&str, v1::Frame) + Send + Sync>;
type Snapshot = events::Snapshot;
const MANAGER_QUEUE_CAPACITY: usize = 256;
const MAX_WATCH_SUBSCRIPTIONS: usize = 512;
const MAX_WORKSPACE_SUBSCRIPTIONS: usize = 256;
const EVENT_BATCH_WINDOW: Duration = Duration::from_millis(100);
const INVALIDATED_RETRY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct WorkspaceWatchStart {
    pub generation: u64,
    pub backend: String,
}

pub struct WorkspaceWatchRegistry {
    state: Mutex<RegistryState>,
    next_generation: AtomicU64,
    sink: EventSink,
}

struct RegistryState {
    managers: HashMap<PathBuf, ManagerEntry>,
    subscriptions: HashMap<String, PathBuf>,
}

struct ManagerEntry {
    sender: mpsc::SyncSender<ManagerCommand>,
    subscriptions: usize,
}

pub(super) enum ManagerCommand {
    Subscribe {
        subscription_id: String,
        relative_path: String,
        absolute_path: PathBuf,
        reply: mpsc::Sender<Result<WorkspaceWatchStart, WorkspaceWatchError>>,
    },
    Unsubscribe(String),
    FileSystem(notify::Result<Event>),
    Overflow,
    Shutdown,
}

pub(super) struct Interest {
    relative_path: String,
    absolute_path: PathBuf,
    snapshot: Snapshot,
    sequence: u64,
    invalidated: bool,
}

impl WorkspaceWatchRegistry {
    pub fn new(sink: impl Fn(&str, v1::Frame) + Send + Sync + 'static) -> Self {
        Self {
            state: Mutex::new(RegistryState {
                managers: HashMap::new(),
                subscriptions: HashMap::new(),
            }),
            next_generation: AtomicU64::new(1),
            sink: Arc::new(sink),
        }
    }

    pub fn subscribe(
        &self,
        subscription_id: &str,
        workspace: WorkspaceRoot,
        relative_path: &str,
    ) -> Result<WorkspaceWatchStart, WorkspaceWatchError> {
        let absolute_path = workspace.resolve_directory(relative_path)?;
        let root = workspace.root().to_path_buf();
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

fn spawn_manager(
    workspace: WorkspaceRoot,
    generation: u64,
    receiver: mpsc::Receiver<ManagerCommand>,
    sender: mpsc::SyncSender<ManagerCommand>,
    sink: EventSink,
) {
    std::thread::spawn(move || {
        let mut backend = match WatchBackend::new(&workspace, sender) {
            Ok(backend) => backend,
            Err(error) => {
                if let Ok(ManagerCommand::Subscribe { reply, .. }) = receiver.recv() {
                    let _ = reply.send(Err(WorkspaceWatchError::Backend(error)));
                }
                return;
            }
        };
        let mut interests = HashMap::<String, Interest>::new();
        let mut pending = VecDeque::new();
        let mut generation = generation;
        loop {
            let command = match pending.pop_front() {
                Some(command) => command,
                None if interests.values().any(|interest| interest.invalidated) => {
                    match receiver.recv_timeout(INVALIDATED_RETRY_INTERVAL) {
                        Ok(command) => command,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if restore_invalidated(&workspace, &mut backend, &mut interests) {
                                generation = generation.saturating_add(1);
                                emit_rescan_all(
                                    &sink,
                                    &mut interests,
                                    generation,
                                    "watchInvalidated",
                                );
                            }
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match receiver.recv() {
                    Ok(command) => command,
                    Err(_) => break,
                },
            };
            match command {
                ManagerCommand::Subscribe {
                    subscription_id,
                    relative_path,
                    absolute_path,
                    reply,
                } => {
                    let result = subscribe_interest(
                        &workspace,
                        &mut backend,
                        &interests,
                        &relative_path,
                        &absolute_path,
                    )
                    .map(|(snapshot, backend_changed)| {
                        if backend_changed {
                            generation = generation.saturating_add(1);
                            for (existing_id, existing) in &mut interests {
                                existing.sequence = existing.sequence.saturating_add(1);
                                emit_rescan(
                                    &sink,
                                    existing_id,
                                    generation,
                                    existing.sequence,
                                    "watchInvalidated",
                                );
                            }
                        }
                        interests.insert(
                            subscription_id,
                            Interest {
                                relative_path,
                                absolute_path,
                                snapshot,
                                sequence: 0,
                                invalidated: false,
                            },
                        );
                        WorkspaceWatchStart {
                            generation,
                            backend: backend.name().to_owned(),
                        }
                    });
                    let _ = reply.send(result);
                }
                ManagerCommand::Unsubscribe(subscription_id) => {
                    if let Some(interest) = interests.remove(&subscription_id)
                        && !interests
                            .values()
                            .any(|other| other.absolute_path == interest.absolute_path)
                    {
                        let _ = backend.unwatch(&interest.absolute_path);
                    }
                }
                ManagerCommand::FileSystem(Ok(event)) => {
                    match collect_event_batch(&receiver, &mut pending, event) {
                        Ok(events) => {
                            let invalidated = reconcile_events(
                                &workspace,
                                &sink,
                                &mut interests,
                                generation,
                                events,
                            );
                            for path in invalidated {
                                let _ = backend.unwatch(&path);
                            }
                        }
                        Err(()) => {
                            generation = generation.saturating_add(1);
                            emit_rescan_all(&sink, &mut interests, generation, "overflow");
                        }
                    }
                }
                ManagerCommand::FileSystem(Err(_)) | ManagerCommand::Overflow => {
                    generation = generation.saturating_add(1);
                    emit_rescan_all(&sink, &mut interests, generation, "overflow");
                }
                ManagerCommand::Shutdown => break,
            }
            if restore_invalidated(&workspace, &mut backend, &mut interests) {
                generation = generation.saturating_add(1);
                emit_rescan_all(&sink, &mut interests, generation, "watchInvalidated");
            }
        }
    });
}

fn collect_event_batch(
    receiver: &mpsc::Receiver<ManagerCommand>,
    pending: &mut VecDeque<ManagerCommand>,
    first: Event,
) -> Result<Vec<Event>, ()> {
    let deadline = Instant::now() + EVENT_BATCH_WINDOW;
    let mut events = vec![first];
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(events);
        };
        match receiver.recv_timeout(remaining) {
            Ok(ManagerCommand::FileSystem(Ok(event))) => events.push(event),
            Ok(ManagerCommand::FileSystem(Err(_)) | ManagerCommand::Overflow) => return Err(()),
            Ok(command) => pending.push_back(command),
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(events),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(events),
        }
    }
}

fn emit_rescan_all(
    sink: &EventSink,
    interests: &mut HashMap<String, Interest>,
    generation: u64,
    reason: &str,
) {
    for (subscription_id, interest) in interests {
        interest.sequence = interest.sequence.saturating_add(1);
        emit_rescan(sink, subscription_id, generation, interest.sequence, reason);
    }
}

fn subscribe_interest(
    workspace: &WorkspaceRoot,
    backend: &mut WatchBackend,
    interests: &HashMap<String, Interest>,
    relative_path: &str,
    absolute_path: &Path,
) -> Result<(Snapshot, bool), WorkspaceWatchError> {
    if !interests
        .values()
        .any(|interest| interest.absolute_path == absolute_path)
    {
        let existing_paths = interests
            .values()
            .map(|interest| interest.absolute_path.as_path())
            .collect::<Vec<_>>();
        let backend_changed = backend.watch(absolute_path, &existing_paths)?;
        return snapshot(workspace, relative_path)
            .map(|snapshot| (snapshot, backend_changed))
            .map_err(WorkspaceWatchError::Workspace);
    }
    snapshot(workspace, relative_path)
        .map(|snapshot| (snapshot, false))
        .map_err(WorkspaceWatchError::Workspace)
}

fn normalize_path(path: &str) -> String {
    if path == "." {
        String::new()
    } else {
        path.trim_matches('/').to_owned()
    }
}
