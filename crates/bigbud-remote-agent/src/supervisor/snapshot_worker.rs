//! The bounded snapshot worker (plan §9.1, N3/N4): two threads per host, matching the limit of
//! two transfers in flight, and a FIFO of 32 waiting requests. A full FIFO answers
//! `SNAPSHOT_BUSY` at once. Fences, serialization and paced chunk sends run here, never under
//! the session lock or on a connection read loop.

use super::Writer;
use super::job_lifecycle::Completion;
use super::writer::budget::TransferSlot;
use crate::session::{SnapshotSource, SnapshotTransfer, produce_snapshot};
use bigbud_protocol::v1;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(super) const WORKERS: usize = 2;
pub(super) const QUEUE_LIMIT: usize = 32;
/// Room for one header or chunk must appear within this long, or the transfer is abandoned.
const FRAME_DEADLINE: Duration = Duration::from_secs(5);

pub(super) struct SnapshotJob {
    pub request: v1::PtyScreenSnapshotRequest,
    pub source: SnapshotSource,
    pub writer: Writer,
    /// Keeps supervisor shutdown from sealing publication under an in-flight transfer.
    pub publication: Completion,
}

struct State {
    jobs: VecDeque<SnapshotJob>,
    stopping: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

pub(super) struct SnapshotWorker {
    shared: Arc<Shared>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl SnapshotWorker {
    pub fn start() -> io::Result<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                jobs: VecDeque::with_capacity(QUEUE_LIMIT),
                stopping: false,
            }),
            changed: Condvar::new(),
        });
        let mut threads = Vec::with_capacity(WORKERS);
        for index in 0..WORKERS {
            let state = Arc::clone(&shared);
            threads.push(
                std::thread::Builder::new()
                    .name(format!("pty-snapshot-{index}"))
                    .spawn(move || run(&state))?,
            );
        }
        Ok(Self {
            shared,
            threads: Mutex::new(threads),
        })
    }

    /// Queues a request; gives it back when the FIFO is full or the worker is stopping.
    pub fn submit(&self, job: SnapshotJob) -> Result<(), Box<SnapshotJob>> {
        let mut state = self.lock();
        if state.stopping || state.jobs.len() >= QUEUE_LIMIT {
            return Err(Box::new(job));
        }
        state.jobs.push_back(job);
        self.shared.changed.notify_one();
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for SnapshotWorker {
    fn drop(&mut self) {
        {
            let mut state = self.lock();
            state.stopping = true;
            // Waiting requests are dropped; their clients time out and retry.
            state.jobs.clear();
        }
        self.shared.changed.notify_all();
        let threads =
            std::mem::take(&mut *self.threads.lock().unwrap_or_else(PoisonError::into_inner));
        for thread in threads {
            // A panic in one transfer was already contained to that transfer's thread.
            let _joined = thread.join();
        }
    }
}

fn run(shared: &Shared) {
    loop {
        let job = {
            let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            loop {
                if state.stopping {
                    return;
                }
                if let Some(job) = state.jobs.pop_front() {
                    break job;
                }
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };
        transfer(job);
    }
}

/// The busy refusal for a request the FIFO cannot hold (the server retries after 250 ms).
pub(super) fn busy(request: &v1::PtyScreenSnapshotRequest) -> v1::Frame {
    SnapshotTransfer::refused(
        request,
        bigbud_protocol::pty_lifecycle::SNAPSHOT_BUSY,
        "snapshot transfers are busy; retry shortly".to_owned(),
    )
    .header_frame()
}

fn transfer(job: SnapshotJob) {
    let SnapshotJob {
        request,
        source,
        writer,
        publication,
    } = job;
    let produced = produce_snapshot(source, &request);
    let slot = Arc::new(TransferSlot::default());
    let send =
        |frame: &v1::Frame| writer.enqueue_snapshot(frame, &slot, Instant::now() + FRAME_DEADLINE);
    let result = send(&produced.header_frame()).and_then(|()| {
        (0..produced.chunk_count()).try_for_each(|index| match produced.chunk_frame(index) {
            Some(frame) => send(&frame),
            None => Err(io::Error::other("snapshot chunk out of range")),
        })
    });
    if let Err(error) = result
        && !writer.is_closed()
    {
        eprintln!("terminal snapshot transfer abandoned: {error}");
    }
    drop(publication);
}
