//! PTY output backpressure (terminal lifecycle R6). Before each read the PTY's reader asks the
//! gate whether every subscriber has room for one more chunk; if not, the PTY is not read and
//! the child blocks on its full kernel buffer. Nothing is dropped and order is kept.
//!
//! A stalled client never stalls other PTYs (each PTY has its own reader) and is never dropped
//! while it is the only subscriber. When several connections share one PTY, a subscriber that
//! stays full with no write progress for `STALL` while another has room is disconnected, as an
//! overflowing one was before, so the others keep receiving output.

use super::super::Subscribers;
use super::super::io_helpers::remove_subscriber;
use super::super::writer::budget;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// An encoded 16 KiB `PtyOutput` frame (payload plus id, sequence and framing).
const FRAME_ROOM: usize = 16 * 1024 + 512;
/// One gate check waits at most this long, so the reader keeps polling the child's exit.
const GATE_WAIT: Duration = Duration::from_millis(50);
/// A delivery whose room vanished after the gate (another PTY on the same connection) waits
/// this long before the old overflow disconnect.
const DELIVERY_WAIT: Duration = Duration::from_secs(10);
const STALL: Duration = Duration::from_secs(5);

pub(super) struct Gate {
    pty_id: String,
    subscribers: Subscribers,
    /// Writer address -> (frames written when first seen full, since when).
    stalls: HashMap<usize, (u64, Instant)>,
}

impl Gate {
    pub fn new(pty_id: &str, subscribers: &Subscribers) -> Self {
        Self {
            pty_id: pty_id.to_owned(),
            subscribers: Arc::clone(subscribers),
            stalls: HashMap::new(),
        }
    }

    /// True when the next chunk may be read.
    pub fn ready(&mut self) -> bool {
        let subscriptions = match self.subscribers.lock() {
            Ok(subscribers) => subscribers.get(&self.pty_id).cloned().unwrap_or_default(),
            Err(_) => return true,
        };
        let deadline = Instant::now() + GATE_WAIT;
        let blocked = subscriptions
            .iter()
            .filter(|subscription| !subscription.wait_room(FRAME_ROOM, deadline))
            .cloned()
            .collect::<Vec<_>>();
        if blocked.is_empty() {
            self.stalls.clear();
            return budget::wait_room(FRAME_ROOM, deadline);
        }
        if blocked.len() < subscriptions.len() {
            let now = Instant::now();
            for subscription in blocked {
                let key = Arc::as_ptr(&subscription.writer) as usize;
                let written = subscription.writer.written_frames();
                let entry = self.stalls.entry(key).or_insert((written, now));
                if entry.0 != written {
                    *entry = (written, now);
                } else if now.duration_since(entry.1) >= STALL {
                    subscription.writer.cancel();
                    self.stalls.remove(&key);
                    if remove_subscriber(&self.subscribers, &self.pty_id, &subscription.writer)
                        .is_err()
                    {
                        // A poisoned registry already refuses every later delivery.
                    }
                }
            }
        }
        false
    }
}

/// Delivers one PTY frame to every subscriber, waiting for room instead of disconnecting.
pub(super) fn broadcast_paced(
    subscribers: &Subscribers,
    pty_id: &str,
    frame: &bigbud_protocol::v1::Frame,
) {
    let subscriptions = match subscribers.lock() {
        Ok(subscribers) => subscribers.get(pty_id).cloned().unwrap_or_default(),
        Err(_) => return,
    };
    let deadline = Instant::now() + DELIVERY_WAIT;
    for subscription in subscriptions {
        if subscription.deliver_paced(frame, deadline).is_err() {
            subscription.writer.cancel();
            if remove_subscriber(subscribers, pty_id, &subscription.writer).is_err() {
                // As above: a poisoned registry refuses later deliveries anyway.
            }
        }
    }
}
