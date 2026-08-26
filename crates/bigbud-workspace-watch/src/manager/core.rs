use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use notify::Event;

use super::helpers::{emit_overflow, emit_rescan_all, restore_interests, subscribe_interest};
use super::recovery::rebuild_backend;
use crate::backend::{WatchBackend, WatchBackendFactory};
use crate::events::{Snapshot, reconcile_events};
use crate::registry::EventSink;
use crate::{WorkspaceRescanReason, WorkspaceWatchError, WorkspaceWatchHost, WorkspaceWatchStart};

const EVENT_BATCH_WINDOW: Duration = Duration::from_millis(100);
const RECOVERY_TICK: Duration = Duration::from_secs(1);
const MAX_RECOVERY_BACKOFF: Duration = Duration::from_secs(30);

pub(crate) enum ManagerCommand {
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

pub(crate) struct Interest {
    pub(crate) relative_path: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) snapshot: Snapshot,
    pub(crate) sequence: u64,
    pub(crate) invalidated: bool,
}

#[derive(Default)]
struct BackendRecovery {
    failures: u32,
    retry_at: Option<Instant>,
}

struct RecoveryDependencies<'a> {
    workspace: &'a dyn WorkspaceWatchHost,
    factory: &'a dyn WatchBackendFactory,
    sender: &'a mpsc::SyncSender<ManagerCommand>,
    sink: &'a EventSink,
}

impl BackendRecovery {
    fn require(&mut self) {
        if self.retry_at.is_none() {
            self.retry_at = Some(Instant::now());
        }
    }

    fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
        let exponent = self.failures.saturating_sub(1).min(5);
        let delay = RECOVERY_TICK
            .saturating_mul(2_u32.saturating_pow(exponent))
            .min(MAX_RECOVERY_BACKOFF);
        self.retry_at = Some(Instant::now() + delay);
    }

    fn clear(&mut self) {
        self.failures = 0;
        self.retry_at = None;
    }

    fn due(&self) -> bool {
        self.retry_at
            .is_some_and(|retry_at| retry_at <= Instant::now())
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

pub(crate) fn spawn_manager(
    workspace: Arc<dyn WorkspaceWatchHost>,
    generation: u64,
    receiver: mpsc::Receiver<ManagerCommand>,
    sender: mpsc::SyncSender<ManagerCommand>,
    sink: EventSink,
    factory: Arc<dyn WatchBackendFactory>,
) {
    std::thread::spawn(move || {
        run_manager(workspace, generation, receiver, sender, sink, factory);
    });
}

fn run_manager(
    workspace: Arc<dyn WorkspaceWatchHost>,
    mut generation: u64,
    receiver: mpsc::Receiver<ManagerCommand>,
    sender: mpsc::SyncSender<ManagerCommand>,
    sink: EventSink,
    factory: Arc<dyn WatchBackendFactory>,
) {
    let mut backend = match factory.create(workspace.as_ref(), sender.clone()) {
        Ok(backend) => backend,
        Err(error) => {
            reject_first_subscription(&receiver, error);
            return;
        }
    };
    let mut interests = HashMap::<String, Interest>::new();
    let mut pending = VecDeque::new();
    let mut recovery = BackendRecovery::default();

    loop {
        recover_if_due(
            RecoveryDependencies {
                workspace: workspace.as_ref(),
                factory: factory.as_ref(),
                sender: &sender,
                sink: &sink,
            },
            &mut backend,
            &mut interests,
            &mut generation,
            &mut recovery,
        );
        let waiting =
            recovery.retry_at.is_some() || interests.values().any(|interest| interest.invalidated);
        let command = match pending.pop_front() {
            Some(command) => command,
            None if waiting => match receiver.recv_timeout(RECOVERY_TICK) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    restore_interests(
                        workspace.as_ref(),
                        &sink,
                        &mut backend,
                        &mut interests,
                        &mut generation,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
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
                    workspace.as_ref(),
                    &mut backend,
                    &interests,
                    &relative_path,
                    &absolute_path,
                )
                .map(|(snapshot, changed)| {
                    if changed {
                        generation = generation.saturating_add(1);
                        emit_rescan_all(
                            &sink,
                            &mut interests,
                            generation,
                            WorkspaceRescanReason::WatchInvalidated,
                            backend.kind(),
                        );
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
                        backend: backend.kind(),
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
                            workspace.as_ref(),
                            &sink,
                            &mut interests,
                            generation,
                            backend.kind(),
                            events,
                        );
                        for path in invalidated {
                            let _ = backend.unwatch(&path);
                        }
                    }
                    Err(BatchFailure::Backend) => invalidate_backend(
                        &sink,
                        &mut interests,
                        &mut generation,
                        backend.kind(),
                        &mut recovery,
                    ),
                    Err(BatchFailure::Overflow) => {
                        emit_overflow(&sink, &mut interests, &mut generation, backend.kind())
                    }
                }
            }
            ManagerCommand::FileSystem(Err(_)) => invalidate_backend(
                &sink,
                &mut interests,
                &mut generation,
                backend.kind(),
                &mut recovery,
            ),
            ManagerCommand::Overflow => {
                emit_overflow(&sink, &mut interests, &mut generation, backend.kind())
            }
            ManagerCommand::Shutdown => break,
        }
        restore_interests(
            workspace.as_ref(),
            &sink,
            &mut backend,
            &mut interests,
            &mut generation,
        );
    }
}

fn recover_if_due(
    dependencies: RecoveryDependencies<'_>,
    backend: &mut WatchBackend,
    interests: &mut HashMap<String, Interest>,
    generation: &mut u64,
    recovery: &mut BackendRecovery,
) {
    if !recovery.due() {
        return;
    }
    match rebuild_backend(
        dependencies.workspace,
        dependencies.factory,
        dependencies.sender.clone(),
        backend,
        interests,
    ) {
        Ok(kind) => {
            *generation = generation.saturating_add(1);
            emit_rescan_all(
                dependencies.sink,
                interests,
                *generation,
                WorkspaceRescanReason::WatchInvalidated,
                kind,
            );
            recovery.clear();
        }
        Err(_) => recovery.failed(),
    }
}

fn invalidate_backend(
    sink: &EventSink,
    interests: &mut HashMap<String, Interest>,
    generation: &mut u64,
    backend: crate::WorkspaceWatchBackend,
    recovery: &mut BackendRecovery,
) {
    *generation = generation.saturating_add(1);
    emit_rescan_all(
        sink,
        interests,
        *generation,
        WorkspaceRescanReason::WatchInvalidated,
        backend,
    );
    recovery.require();
}

fn reject_first_subscription(receiver: &mpsc::Receiver<ManagerCommand>, error: notify::Error) {
    if let Ok(ManagerCommand::Subscribe { reply, .. }) = receiver.recv() {
        let _ = reply.send(Err(WorkspaceWatchError::Backend(error)));
    }
}

enum BatchFailure {
    Backend,
    Overflow,
}

fn collect_event_batch(
    receiver: &mpsc::Receiver<ManagerCommand>,
    pending: &mut VecDeque<ManagerCommand>,
    first: Event,
) -> Result<Vec<Event>, BatchFailure> {
    let deadline = Instant::now() + EVENT_BATCH_WINDOW;
    let mut events = vec![first];
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(events);
        };
        match receiver.recv_timeout(remaining) {
            Ok(ManagerCommand::FileSystem(Ok(event))) => events.push(event),
            Ok(ManagerCommand::FileSystem(Err(_))) => return Err(BatchFailure::Backend),
            Ok(ManagerCommand::Overflow) => return Err(BatchFailure::Overflow),
            Ok(command) => pending.push_back(command),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                return Ok(events);
            }
        }
    }
}
