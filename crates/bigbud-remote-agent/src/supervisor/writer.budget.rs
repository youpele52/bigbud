use bigbud_protocol::{encode_frame, encoded_frame_length, v1};
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Instant;

pub(super) static PROFILE_BYTES: AtomicUsize = AtomicUsize::new(0);
/// Producers waiting for budget (PTY backpressure); frees notify only while one waits.
static WAITERS: AtomicUsize = AtomicUsize::new(0);
static FREED: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());
static ENCODERS: AtomicUsize = AtomicUsize::new(0);
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(in crate::supervisor) struct EncodedFrame {
    pub bytes: Vec<u8>,
    charge: usize,
    /// A snapshot transfer's slot, released when the writer is done with this frame.
    slot: Option<Arc<TransferSlot>>,
}

/// One snapshot transfer's hold on the writer (plan §9.1, N3): at most one of its encoded
/// chunks is queued at a time, so a transfer charges at most one chunk to the global budget.
#[derive(Default)]
pub(in crate::supervisor) struct TransferSlot {
    queued: Mutex<bool>,
    changed: Condvar,
}

impl TransferSlot {
    /// Waits until the transfer's previous frame has left the queue, or `deadline` passes.
    pub fn wait_idle(&self, deadline: Instant) -> io::Result<()> {
        let mut queued = self.queued.lock().unwrap_or_else(PoisonError::into_inner);
        while *queued {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            queued = self
                .changed
                .wait_timeout(queued, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        Ok(())
    }

    fn set(&self, value: bool) {
        *self.queued.lock().unwrap_or_else(PoisonError::into_inner) = value;
        self.changed.notify_all();
    }
}
impl EncodedFrame {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}
impl Drop for EncodedFrame {
    fn drop(&mut self) {
        drop(std::mem::take(&mut self.bytes));
        PROFILE_BYTES.fetch_sub(self.charge, Ordering::AcqRel);
        if WAITERS.load(Ordering::Acquire) > 0 {
            let _guard = FREED.0.lock().unwrap_or_else(PoisonError::into_inner);
            FREED.1.notify_all();
        }
        if let Some(slot) = self.slot.take() {
            slot.set(false);
        }
    }
}
struct Encoder;
impl Drop for Encoder {
    fn drop(&mut self) {
        ENCODERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// All allocated encoded copies, including waiting replay/control frames and
/// handoff spools, retain the same profile charge until their buffer is dropped.
pub(in crate::supervisor) fn encode(frame: &v1::Frame, maximum: usize) -> io::Result<EncodedFrame> {
    encode_with_slot(frame, maximum, None)
}

/// Whether `bytes` more would fit the global budget now.
pub(in crate::supervisor) fn has_room(bytes: usize) -> bool {
    PROFILE_BYTES
        .load(Ordering::Acquire)
        .checked_add(bytes)
        .is_some_and(|next| next <= MAX_BYTES)
}

/// Waits until `bytes` more fit the global budget, or `deadline` passes.
pub(in crate::supervisor) fn wait_room(bytes: usize, deadline: Instant) -> bool {
    if has_room(bytes) {
        return true;
    }
    WAITERS.fetch_add(1, Ordering::AcqRel);
    let mut guard = FREED.0.lock().unwrap_or_else(PoisonError::into_inner);
    let fits = loop {
        if has_room(bytes) {
            break true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break false;
        }
        // Bounded slices: a free racing the check above is seen within 5 ms at worst.
        guard = FREED
            .1
            .wait_timeout(guard, remaining.min(std::time::Duration::from_millis(5)))
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    };
    drop(guard);
    WAITERS.fetch_sub(1, Ordering::AcqRel);
    fits
}

/// Encodes once the budget has room (PTY output backpressure) instead of failing at once.
pub(in crate::supervisor) fn encode_waiting(
    frame: &v1::Frame,
    maximum: usize,
    deadline: Instant,
) -> io::Result<EncodedFrame> {
    loop {
        match encode(frame, maximum) {
            Ok(encoded) => return Ok(encoded),
            Err(error) => {
                let size = encoded_frame_length(frame, maximum).map_err(io::Error::other)?;
                if !wait_room(size, deadline) {
                    return Err(error);
                }
            }
        }
    }
}

/// Encodes a snapshot frame whose queue slot is released when the frame is written or dropped.
pub(in crate::supervisor) fn encode_for_transfer(
    frame: &v1::Frame,
    maximum: usize,
    slot: &Arc<TransferSlot>,
) -> io::Result<EncodedFrame> {
    encode_with_slot(frame, maximum, Some(slot))
}

fn encode_with_slot(
    frame: &v1::Frame,
    maximum: usize,
    slot: Option<&Arc<TransferSlot>>,
) -> io::Result<EncodedFrame> {
    let size = encoded_frame_length(frame, maximum).map_err(io::Error::other)?;
    ENCODERS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < 64).then_some(active + 1)
        })
        .map_err(|_| io::Error::other("encoder concurrency exhausted"))?;
    let _encoder = Encoder;
    PROFILE_BYTES
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
            used.checked_add(size).filter(|next| *next <= MAX_BYTES)
        })
        .map_err(|_| io::Error::other("encoded profile budget exhausted"))?;
    let mut encoded = EncodedFrame {
        bytes: Vec::new(),
        charge: size,
        slot: None,
    };
    encoded.bytes = encode_frame(frame, maximum).map_err(io::Error::other)?;
    if let Some(slot) = slot {
        slot.set(true);
        encoded.slot = Some(Arc::clone(slot));
    }
    Ok(encoded)
}

#[cfg(test)]
#[path = "writer.budget.tests.rs"]
mod tests;
