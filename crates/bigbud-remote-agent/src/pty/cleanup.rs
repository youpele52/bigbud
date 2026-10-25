use super::child::Child;
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(1);
static OWNER_ACTIVE: AtomicBool = AtomicBool::new(false);
struct Slot {
    child: Option<Arc<Child>>,
    cleanup: bool,
}
static PENDING: Mutex<BTreeMap<u64, Slot>> = Mutex::new(BTreeMap::new());

/// Capacity is held BEFORE fork. Setup failures retain their direct-child
/// identity here until verified reap; unknown cleanup never frees admission.
pub(super) struct Reservation {
    id: u64,
    retained: bool,
}
impl Reservation {
    pub fn reserve() -> io::Result<Self> {
        poll();
        let mut pending = PENDING
            .lock()
            .map_err(|_| io::Error::other("pending reap registry poisoned"))?;
        if pending.len() >= 64 {
            return Err(io::Error::other("pending child capacity exhausted"));
        }
        let id = NEXT
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |next| {
                next.checked_add(1)
            })
            .map_err(|_| io::Error::other("pending child generation exhausted"))?;
        pending.insert(
            id,
            Slot {
                child: None,
                cleanup: false,
            },
        );
        Ok(Self {
            id,
            retained: false,
        })
    }
    pub fn retain(&mut self, child: Arc<Child>) -> io::Result<()> {
        PENDING
            .lock()
            .map_err(|_| io::Error::other("pending reap registry poisoned"))?
            .insert(
                self.id,
                Slot {
                    child: Some(child),
                    cleanup: false,
                },
            );
        self.retained = true;
        Ok(())
    }
    pub fn transfer(mut self) {
        self.retained = false;
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut pending) = PENDING.lock() {
            if self.retained {
                if let Some(slot) = pending.get_mut(&self.id) {
                    slot.cleanup = true;
                }
            } else {
                pending.remove(&self.id);
            }
        }
    }
}

pub(super) fn poll() {
    let children = match PENDING.lock() {
        Ok(pending) => pending
            .iter()
            .filter_map(|(id, slot)| {
                if slot.cleanup {
                    slot.child.as_ref().map(|child| (*id, Arc::clone(child)))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    for (id, child) in children {
        // Errors deliberately keep ownership/capacity. Never abandon an unknown
        // child because a kill, wait or elapsed-time budget failed.
        poll_one(id, child.poll(), || child.signal(libc::SIGKILL));
    }
}

fn poll_one(
    id: u64,
    wait: io::Result<Option<super::child::Exit>>,
    signal: impl FnOnce() -> io::Result<()>,
) {
    if wait.is_ok_and(|exit| exit.is_some()) {
        if let Ok(mut pending) = PENDING.lock() {
            pending.remove(&id);
        }
    } else if signal().is_err() {
        // Retain ownership and capacity; failure is not proof that the child died.
    }
}

#[cfg(test)]
pub(super) fn retained_children() -> Vec<Arc<Child>> {
    PENDING
        .lock()
        .unwrap()
        .values()
        .filter(|slot| slot.cleanup)
        .filter_map(|slot| slot.child.clone())
        .collect()
}

#[cfg(test)]
#[path = "cleanup.tests.rs"]
mod tests;
pub fn settled() -> bool {
    poll();
    PENDING.lock().is_ok_and(|pending| pending.is_empty())
}

/// Explicit supervisor/stdio owner of the single bounded failed-setup reaper.
/// Drop cancels and joins; unresolved identities remain fenced in the registry.
pub struct CleanupOwner {
    cancel: Arc<AtomicBool>,
    done: mpsc::Receiver<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl CleanupOwner {
    pub fn start() -> io::Result<Self> {
        OWNER_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| io::Error::other("pending-reap owner already active"))?;
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let (finished, done) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("pty-pending-reap".to_owned())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    poll();
                    std::thread::sleep(Duration::from_millis(100));
                }
                poll();
                OWNER_ACTIVE.store(false, Ordering::Release);
                let _ = finished.send(()); // Dropped owner cannot reopen native authority.
            });
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                OWNER_ACTIVE.store(false, Ordering::Release);
                return Err(error);
            }
        };
        Ok(Self {
            cancel,
            done,
            worker: Some(worker),
        })
    }
}
impl Drop for CleanupOwner {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if self.done.recv_timeout(Duration::from_millis(500)).is_ok() {
            if let Some(worker) = self.worker.take()
                && worker.join().is_err()
            {
                eprintln!("PTY pending-reap owner failed to join");
            }
        } else {
            eprintln!("PTY pending-reap shutdown unconfirmed; cleanup stays fenced");
        }
    }
}
