use super::Writer;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static SEALED: AtomicBool = AtomicBool::new(false);
static STARTS: Mutex<()> = Mutex::new(());
static WRITERS: Mutex<Vec<Weak<super::writer::OutboundWriter>>> = Mutex::new(Vec::new());
// One immutable, at-most-64-writer terminal owner. Unknown workers keep their
// handles here until process exit; releasing connection/snapshot Arcs cannot
// invoke a fresh destructor join or detach an unconfirmed worker.
static TERMINAL_WRITERS: Mutex<Option<Vec<Writer>>> = Mutex::new(None);
pub(super) struct Completion;
impl Completion {
    pub fn begin() -> Self {
        ACTIVE.fetch_add(1, Ordering::AcqRel);
        Self
    }
    pub fn publication() -> Option<Self> {
        let _permit = STARTS.lock().ok()?;
        if SEALED.load(Ordering::Acquire) {
            None
        } else {
            Some(Self::begin())
        }
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) fn settled() -> bool {
    ACTIVE.load(Ordering::Acquire) == 0
}
pub(super) fn seal() -> bool {
    let Ok(_permit) = STARTS.lock() else {
        return false;
    };
    if !settled() {
        return false;
    }
    SEALED.store(true, Ordering::Release);
    true
}
pub(super) fn register(writer: &Writer) -> io::Result<()> {
    let _permit = STARTS
        .lock()
        .map_err(|_| io::Error::other("writer publication poisoned"))?;
    if SEALED.load(Ordering::Acquire) {
        return Err(io::Error::other("supervisor publication fenced"));
    }
    let mut writers = WRITERS
        .lock()
        .map_err(|_| io::Error::other("writer ownership poisoned"))?;
    writers.retain(|writer| writer.upgrade().is_some_and(|writer| !writer.is_closed()));
    if writers.len() >= 64 {
        return Err(io::Error::other("writer ownership budget exceeded"));
    }
    writers.push(Arc::downgrade(writer));
    Ok(())
}
/// Jobs remain live THROUGH completion fan-out. Only after their permits settle
/// can this fixed snapshot drain every owned writer, not just the shutdown peer.
pub(super) fn drain_all(deadline: Instant) -> io::Result<()> {
    let writers = terminal_writers()?;
    let mut failure = None;
    for writer in &writers {
        if !writer.is_closed() {
            let result = writer.drain_until(deadline);
            #[cfg(test)]
            let result = super::test_hooks::shutdown_drain_result(result);
            if let Err(error) = result {
                writer.cancel();
                failure.get_or_insert(error);
            }
        }
    }
    // Install the shared fence before cancellation wakes connection cleanup.
    let join_deadline = Instant::now() + Duration::from_millis(500);
    for writer in &writers {
        if let Err(error) = writer.fence_join_deadline(join_deadline) {
            failure.get_or_insert(error);
        }
    }
    // Close every transport before joining any worker. Failed/expired drains
    // discard that peer's queued frames and wake both reader and writer; they
    // do not prevent other peers from draining under the same deadline.
    for writer in &writers {
        writer.cancel();
    }
    for writer in &writers {
        if let Err(error) = writer.join_until(join_deadline) {
            failure.get_or_insert(error);
        }
    }
    #[cfg(test)]
    super::test_hooks::shutdown_writers_disposed(&writers);
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn terminal_writers() -> io::Result<Vec<Writer>> {
    if !SEALED.load(Ordering::Acquire) {
        return Err(io::Error::other(
            "terminal writer ownership requires publication seal",
        ));
    }
    let mut owner = TERMINAL_WRITERS
        .lock()
        .map_err(|_| io::Error::other("terminal writer ownership poisoned"))?;
    if let Some(writers) = &*owner {
        return Ok(writers.clone());
    }
    let writers = WRITERS
        .lock()
        .map_err(|_| io::Error::other("writer ownership poisoned"))?
        .iter()
        .filter_map(Weak::upgrade)
        .collect::<Vec<_>>();
    *owner = Some(writers.clone());
    Ok(writers)
}
