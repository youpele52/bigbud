use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

#[path = "input.ledger.rs"]
mod ledger;
use ledger::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputOutcome {
    Accepted,
    Writing(usize),
    Written(usize),
    FailedBeforeWrite,
    PartialUnknown(usize),
}

impl InputOutcome {
    fn settled(self) -> bool {
        !matches!(self, Self::Accepted | Self::Writing(_))
    }
}

struct Work {
    sequence: u64,
    bytes: Vec<u8>,
    deadline: Instant,
}
impl Drop for Work {
    fn drop(&mut self) {
        let bytes = std::mem::take(&mut self.bytes);
        let length = bytes.len();
        drop(bytes);
        INPUT_BYTES.fetch_sub(length, Ordering::AcqRel);
    }
}

/// One bounded writer per PTY. Reservations precede all I/O; expired identities never replay.
pub struct InputWriter {
    identity: Vec<u8>,
    shared: Arc<Shared>,
    sender: mpsc::SyncSender<Work>,
    done: Mutex<mpsc::Receiver<()>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl InputWriter {
    pub fn start(
        identity: Vec<u8>,
        mut write: impl FnMut(&[u8]) -> io::Result<usize> + Send + 'static,
    ) -> io::Result<Self> {
        let shared = Arc::new(Shared {
            ledger: Mutex::new(Ledger {
                records: BTreeMap::new(),
                high_water: 0,
                expired_through: 0,
                fenced: false,
                pending: 0,
                bytes: 0,
            }),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
        let (sender, receiver) = mpsc::sync_channel::<Work>(256);
        register(&shared)?;
        let (finished, done) = mpsc::channel();
        let state = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("pty-input".to_owned())
            .spawn(move || {
                while !state.cancelled.load(Ordering::Acquire) {
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Ok(work) => process(&state, &work, &mut write),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                // Cancellation settles every reserved entry, without emitting further bytes.
                for work in receiver.try_iter() {
                    settle(&state, &work, InputOutcome::FailedBeforeWrite);
                }
                state.finished.store(true, Ordering::Release);
                let _ = finished.send(()); // Receiver loss only means the owner already detached.
            })?;
        Ok(Self {
            identity,
            shared,
            sender,
            done: Mutex::new(done),
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn digest(&self, sequence: u64, bytes: &[u8]) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(b"bigbud/pty-input/internal-v1\0");
        hash.update((self.identity.len() as u64).to_be_bytes());
        hash.update(&self.identity);
        hash.update(sequence.to_be_bytes());
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
        hash.finalize().into()
    }

    pub fn submit(&self, sequence: u64, bytes: &[u8]) -> Result<bool, super::PtyError> {
        if bytes.len() > super::MAX_INPUT_BYTES {
            return Err(super::PtyError::InputLimit);
        }
        let digest = self.digest(sequence, bytes);
        reclaim_expired(Instant::now());
        let mut ledger = self.shared.ledger.lock().map_err(|_| super::poisoned())?;
        prune(&mut ledger, Instant::now());
        if sequence <= ledger.expired_through {
            return Err(super::PtyError::InputExpired);
        }
        if let Some(record) = ledger.records.get(&sequence) {
            return if record.digest == digest {
                Ok(false)
            } else {
                Err(super::PtyError::InputConflict)
            };
        }
        if self.shared.cancelled.load(Ordering::Acquire) || ledger.fenced {
            return Err(super::PtyError::InputFenced);
        }
        let expected = ledger
            .high_water
            .checked_add(1)
            .ok_or(super::PtyError::InputExpired)?;
        if sequence != expected {
            return Err(super::PtyError::InputSequence {
                expected,
                actual: sequence,
            });
        }
        compact_completed(&mut ledger);
        if ledger.records.len() >= 4096
            || ledger.pending >= 256
            || ledger.bytes + bytes.len() > 512 * 1024
        {
            return Err(super::PtyError::InputLimit);
        }
        if !reserve(&LEDGER_BYTES, ENTRY_COST) {
            return Err(super::PtyError::InputLimit);
        }
        if !reserve(&INPUT_BYTES, bytes.len()) {
            LEDGER_BYTES.fetch_sub(ENTRY_COST, Ordering::AcqRel);
            return Err(super::PtyError::InputLimit);
        }
        ledger.records.insert(
            sequence,
            Record {
                digest,
                outcome: InputOutcome::Accepted,
                completed: None,
            },
        );
        ledger.high_water = sequence;
        ledger.pending += 1;
        ledger.bytes += bytes.len();
        let work = Work {
            sequence,
            bytes: bytes.to_vec(),
            deadline: Instant::now() + Duration::from_secs(5),
        };
        if let Err(error) = self.sender.try_send(work) {
            let (mpsc::TrySendError::Full(work) | mpsc::TrySendError::Disconnected(work)) = error;
            // Admission was reserved, so preserve the identity even on worker failure.
            drop(ledger);
            settle(&self.shared, &work, InputOutcome::FailedBeforeWrite);
        }
        Ok(true)
    }

    pub fn status(&self, sequence: u64) -> Result<InputOutcome, super::PtyError> {
        let mut ledger = self.shared.ledger.lock().map_err(|_| super::poisoned())?;
        prune(&mut ledger, Instant::now());
        ledger
            .records
            .get(&sequence)
            .map(|record| record.outcome)
            .ok_or(super::PtyError::InputExpired)
    }

    pub fn wait(&self, sequence: u64) -> Result<InputOutcome, super::PtyError> {
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut ledger = self.shared.ledger.lock().map_err(|_| super::poisoned())?;
        loop {
            let outcome = ledger
                .records
                .get(&sequence)
                .ok_or(super::PtyError::InputExpired)?
                .outcome;
            if outcome.settled() {
                return Ok(outcome);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                // Unexpected worker delay cannot leave a rejected legacy request
                // executing later while newer sequences bypass its uncertainty.
                ledger.fenced = true;
                self.shared.cancelled.store(true, Ordering::Release);
                return Err(super::PtyError::InputFenced);
            }
            let (next, _) = self
                .shared
                .changed
                .wait_timeout(ledger, remaining)
                .map_err(|_| super::poisoned())?;
            ledger = next;
        }
    }

    pub fn cancel(&self) {
        // Admission holds this permit through try_send. Cancellation cannot let
        // the receiver finish draining before an accepted work item is enqueued.
        let _permit = self.shared.ledger.lock();
        self.shared.cancelled.store(true, Ordering::Release);
    }

    pub fn finished(&self) -> bool {
        self.shared.finished.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) -> Result<(), super::PtyError> {
        self.cancel();
        let mut worker = self.worker.lock().map_err(|_| super::poisoned())?;
        if worker.is_none() {
            return Ok(());
        }
        self.done
            .lock()
            .map_err(|_| super::poisoned())?
            .recv_timeout(Duration::from_millis(500))
            .map_err(|_| super::PtyError::InputFenced)?;
        if let Some(worker) = worker.take() {
            worker.join().map_err(|_| super::PtyError::InputFenced)?;
        }
        Ok(())
    }
}
impl Drop for InputWriter {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn settle(shared: &Shared, work: &Work, outcome: InputOutcome) {
    if let Ok(mut ledger) = shared.ledger.lock() {
        ledger.fenced |= matches!(outcome, InputOutcome::PartialUnknown(_));
        if let Some(record) = ledger.records.get_mut(&work.sequence) {
            record.outcome = outcome;
            record.completed = Some(Instant::now());
        }
        ledger.pending -= 1;
        ledger.bytes -= work.bytes.len();
        shared.changed.notify_all();
    }
}

fn process(shared: &Shared, work: &Work, write: &mut impl FnMut(&[u8]) -> io::Result<usize>) {
    let mut written = 0;
    loop {
        // A successful final syscall is completion even when cancellation or the
        // deadline becomes visible before this worker gets its next time slice.
        if written == work.bytes.len() {
            settle(shared, work, InputOutcome::Written(written));
            return;
        }
        let fenced = match shared.ledger.lock() {
            Ok(mut ledger) => {
                if let Some(record) = ledger.records.get_mut(&work.sequence) {
                    record.outcome = InputOutcome::Writing(written);
                }
                ledger.fenced
            }
            Err(_) => true,
        };
        if fenced || shared.cancelled.load(Ordering::Acquire) || Instant::now() >= work.deadline {
            break;
        }
        let Some(remaining) = work.bytes.get(written..) else {
            break;
        };
        match write(remaining) {
            Ok(0) => break,
            Ok(size) if size <= remaining.len() => written += size,
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(_) => break,
        }
    }
    settle(
        shared,
        work,
        if written == 0 {
            InputOutcome::FailedBeforeWrite
        } else {
            InputOutcome::PartialUnknown(written)
        },
    );
}

#[cfg(test)]
#[path = "input.tests.rs"]
mod tests;
