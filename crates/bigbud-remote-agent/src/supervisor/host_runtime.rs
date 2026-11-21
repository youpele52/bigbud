//! The supervisor's terminal-host runtime (plan R5): connected owners, the broadcast sink for
//! unsolicited lifecycle frames (83, 84, 93), and the snapshot worker. An owner is any data
//! connection that completed its hello; the orphan timer runs only while none is connected.

use super::Writer;
use super::job_lifecycle::Completion;
use super::snapshot_worker::SnapshotWorker;
use crate::session::HostLifecycle;
use bigbud_protocol::v1;
use std::io;
use std::sync::{Arc, Mutex, PoisonError};

struct Owner {
    writer: Writer,
    /// The client speaks protocol 1.9 or later and consumes unsolicited lifecycle frames.
    lifecycle_events: bool,
}

pub(super) struct HostRuntime {
    pub host: Arc<HostLifecycle>,
    pub snapshots: SnapshotWorker,
    owners: Mutex<Vec<Owner>>,
}

impl HostRuntime {
    pub fn start(host: Arc<HostLifecycle>) -> io::Result<Arc<Self>> {
        let runtime = Arc::new(Self {
            host: Arc::clone(&host),
            snapshots: SnapshotWorker::start()?,
            owners: Mutex::new(Vec::new()),
        });
        let weak = Arc::downgrade(&runtime);
        host.set_sink(Arc::new(move |frame: &v1::Frame| {
            if let Some(runtime) = weak.upgrade() {
                runtime.broadcast(frame);
            }
        }));
        Ok(runtime)
    }

    fn owners(&self) -> std::sync::MutexGuard<'_, Vec<Owner>> {
        self.owners.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn add_owner(&self, writer: &Writer, lifecycle_events: bool) {
        let mut owners = self.owners();
        if owners
            .iter()
            .any(|owner| Arc::ptr_eq(&owner.writer, writer))
        {
            return;
        }
        owners.push(Owner {
            writer: Arc::clone(writer),
            lifecycle_events,
        });
        drop(owners);
        self.host.owner_connected();
    }

    pub fn remove_owner(&self, writer: &Writer) {
        let mut owners = self.owners();
        let before = owners.len();
        owners.retain(|owner| !Arc::ptr_eq(&owner.writer, writer));
        let removed = owners.len() != before;
        drop(owners);
        if removed {
            self.host.owner_disconnected();
        }
    }

    /// Bounded and nonblocking: each owner's streaming window applies, as for PTY output.
    fn broadcast(&self, frame: &v1::Frame) {
        let Some(_publication) = Completion::publication() else {
            return;
        };
        let owners = self
            .owners()
            .iter()
            .filter(|owner| owner.lifecycle_events)
            .map(|owner| Arc::clone(&owner.writer))
            .collect::<Vec<_>>();
        for owner in owners {
            if owner.is_closed() {
                continue;
            }
            if owner.enqueue_terminal(frame).is_err() {
                // An exhausted window already cancelled that connection; it reconnects and
                // replays notices through HostNoticeReplay.
            }
        }
    }
}
