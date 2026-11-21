//! The spool writer thread: 64 KiB buffering, a 2 s flush cadence, rotation between the two
//! segments and atomic checkpoints. Any I/O failure disables the spool (plan §14).

use std::fs::File;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Instant;

use super::checkpoint;
use super::errors::SpoolLimits;
use super::layout::{self, CHECKPOINT_FILE, META_FILE};
use super::meta::{SpoolMeta, SpoolState};
use super::segment;
use super::writer::{Message, WriterShared};

pub(super) struct WriterThread {
    pub(super) dir: PathBuf,
    pub(super) limits: SpoolLimits,
    pub(super) shared: Arc<WriterShared>,
    pub(super) meta: SpoolMeta,
    pub(super) segments: [File; 2],
    pub(super) active: usize,
    pub(super) active_len: u64,
    pub(super) last_sequence: [Option<u64>; 2],
    pub(super) pending: Vec<u8>,
    pub(super) half_requested: bool,
    pub(super) last_flush: Instant,
}

impl WriterThread {
    pub(super) fn run(mut self, receiver: Receiver<Message>) -> Result<(), String> {
        loop {
            let message = if self.pending.is_empty() {
                receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                let due = self.last_flush + self.limits.flush_interval;
                receiver.recv_timeout(due.saturating_duration_since(Instant::now()))
            };
            match message {
                Ok(Message::Output { sequence, bytes }) => {
                    self.shared
                        .queued_bytes
                        .fetch_sub(bytes.len(), Ordering::AcqRel);
                    if !self.disabled() {
                        let result = self.add_record(sequence, &bytes);
                        self.guard(result);
                    }
                }
                Ok(Message::Checkpoint {
                    through_sequence,
                    blob,
                }) => {
                    if !self.disabled() {
                        let result = self.write_checkpoint(through_sequence, &blob);
                        self.guard(result);
                    }
                }
                Ok(Message::Flush(reply)) => {
                    let result = if self.disabled() {
                        Ok(())
                    } else {
                        self.flush_pending().and_then(|()| self.sync_active())
                    };
                    let outcome = result.as_ref().map_err(ToString::to_string).copied();
                    self.guard(result);
                    if reply.send(outcome).is_err() {
                        // The caller stopped waiting (timeout); the flush still happened.
                    }
                }
                Ok(Message::Shrink) => {
                    if !self.disabled() {
                        let result = self.shrink();
                        self.guard(result);
                    }
                }
                Ok(Message::Degraded) => {}
                Ok(Message::Stop { remove }) => return self.finish(remove),
                Err(RecvTimeoutError::Timeout) => {
                    if !self.disabled() {
                        let result = self.flush_pending();
                        self.guard(result);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return self.finish(false),
            }
            self.persist_degraded();
        }
    }

    fn disabled(&self) -> bool {
        self.shared.degraded.load(Ordering::Acquire)
    }

    fn guard(&mut self, result: io::Result<()>) {
        if result.is_err() {
            self.shared.degraded.store(true, Ordering::Release);
            self.pending.clear();
        }
    }

    /// Records the degraded flag durably once, so a cold read never presents a gap as full.
    fn persist_degraded(&mut self) {
        if self.disabled() && !self.meta.degraded {
            self.pending.clear();
            self.meta.degraded = true;
            if self.meta.store(&self.dir.join(META_FILE)).is_err() {
                // Retried after the next message; segments already end at the gap.
                self.meta.degraded = false;
            }
        }
    }

    fn add_record(&mut self, sequence: u64, bytes: &[u8]) -> io::Result<()> {
        let record = segment::encoded_len(bytes.len()) as u64;
        let filled = self.active_len + self.pending.len() as u64;
        if filled > 0 && filled + record > self.limits.segment_bytes {
            self.flush_pending()?;
            self.rotate()?;
        }
        segment::encode_into(&mut self.pending, sequence, bytes);
        if let Some(slot) = self.last_sequence.get_mut(self.active) {
            *slot = Some(sequence);
        }
        self.shared
            .output_since_checkpoint
            .store(true, Ordering::Release);
        let filled = self.active_len + self.pending.len() as u64;
        if !self.half_requested && filled >= self.limits.segment_bytes / 2 {
            // Ask for a checkpoint well before the older segment is reused.
            self.half_requested = true;
            self.shared.checkpoint_wanted.store(true, Ordering::Release);
        }
        if self.pending.len() >= self.limits.buffer_bytes {
            self.flush_pending()?;
        }
        Ok(())
    }

    fn flush_pending(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            let file = self
                .segments
                .get_mut(self.active)
                .ok_or_else(|| io::Error::other("spool segment index out of range"))?;
            file.write_all(&self.pending)?;
            self.active_len += self.pending.len() as u64;
            self.pending.clear();
        }
        self.last_flush = Instant::now();
        Ok(())
    }

    fn sync_active(&mut self) -> io::Result<()> {
        self.segment(self.active)?.sync_data()
    }

    fn segment(&mut self, index: usize) -> io::Result<&mut File> {
        self.segments
            .get_mut(index)
            .ok_or_else(|| io::Error::other("spool segment index out of range"))
    }

    /// Reuses the older segment. The meta records what is discarded before the truncate, so a
    /// crash in between only makes coverage look more conservative.
    fn rotate(&mut self) -> io::Result<()> {
        self.sync_active()?;
        let next = 1 - self.active;
        self.discard(next)?;
        self.active = next;
        self.active_len = 0;
        self.half_requested = false;
        self.shared.checkpoint_wanted.store(true, Ordering::Release);
        Ok(())
    }

    fn discard(&mut self, index: usize) -> io::Result<()> {
        if let Some(discarded) = self.last_sequence.get(index).copied().flatten() {
            self.meta.discarded_through = Some(
                self.meta
                    .discarded_through
                    .map_or(discarded, |known| known.max(discarded)),
            );
            self.meta.store(&self.dir.join(META_FILE))?;
        }
        let file = self.segment(index)?;
        file.set_len(0)?;
        file.sync_all()?;
        if let Some(slot) = self.last_sequence.get_mut(index) {
            *slot = None;
        }
        Ok(())
    }

    fn shrink(&mut self) -> io::Result<()> {
        self.flush_pending()?;
        self.sync_active()?;
        self.discard(1 - self.active)
    }

    fn write_checkpoint(&mut self, through_sequence: u64, blob: &[u8]) -> io::Result<()> {
        self.flush_pending()?;
        self.sync_active()?;
        checkpoint::store(&self.dir.join(CHECKPOINT_FILE), through_sequence, blob)?;
        self.meta.checkpoint_through = Some(through_sequence);
        self.meta.store(&self.dir.join(META_FILE))?;
        self.shared
            .checkpoint_wanted
            .store(false, Ordering::Release);
        self.shared
            .output_since_checkpoint
            .store(false, Ordering::Release);
        self.shared
            .last_checkpoint_ms
            .store(self.shared.elapsed_ms(), Ordering::Release);
        Ok(())
    }

    fn finish(mut self, remove: bool) -> Result<(), String> {
        if remove {
            // Mark closed first so the sweep deletes the spool if the removal below fails.
            self.meta.state = SpoolState::Closed;
            let marked = self.meta.store(&self.dir.join(META_FILE));
            let [first, second] = self.segments;
            drop((first, second));
            return layout::remove_spool_dir(&self.dir)
                .or(marked)
                .map_err(|error| error.to_string());
        }
        if !self.disabled() {
            let result = self.flush_pending().and_then(|()| self.sync_active());
            self.guard(result);
        }
        self.persist_degraded();
        Ok(())
    }
}
