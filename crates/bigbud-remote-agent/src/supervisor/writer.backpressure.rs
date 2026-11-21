//! Stream-window backpressure for PTY output (terminal lifecycle R6). The PTY reader asks for
//! room before reading another chunk; while a connection's 256 KiB stream window is full the
//! PTY is simply not read, so the kernel buffer throttles the child instead of the client
//! being dropped. Other producers keep the immediate overflow cancel.

use super::budget::{self, EncodedFrame};
use super::{BYTE_LIMIT, ITEM_LIMIT, OutboundWriter};
use bigbud_protocol::v1;
use std::io;
use std::sync::atomic::Ordering;
use std::time::Instant;

impl OutboundWriter {
    /// Frames this writer has fully written (progress, for stall detection).
    pub(in crate::supervisor) fn written_frames(&self) -> u64 {
        self.shared.written.load(Ordering::Acquire)
    }

    /// Waits until the stream window has room for `bytes`, or `deadline` passes. A closed
    /// writer reports room: delivery then fails and the subscriber is removed as before.
    pub(in crate::supervisor) fn wait_stream_room(&self, bytes: usize, deadline: Instant) -> bool {
        let Ok(mut queue) = self.shared.queue.lock() else {
            return true;
        };
        loop {
            if self.is_closed()
                || (queue.stream_bytes + bytes <= BYTE_LIMIT && queue.stream_items < ITEM_LIMIT)
            {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            queue = match self.shared.changed.wait_timeout(queue, remaining) {
                Ok((queue, _)) => queue,
                Err(_) => return true,
            };
        }
    }

    /// Queues a small unsolicited frame if the stream window has room; otherwise skips it and
    /// keeps the connection. Lifecycle notices stay replayable (`HostNoticeReplay`, numbered
    /// ids) and activity and resource reports are periodic state, so a skip loses nothing a
    /// disconnect would not lose too.
    pub(in crate::supervisor) fn try_enqueue_stream(&self, frame: &v1::Frame) -> io::Result<bool> {
        let encoded = budget::encode(frame, BYTE_LIMIT - 4)?;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| io::Error::other("writer queue poisoned"))?;
        if self.is_closed() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if queue.stream_bytes + encoded.len() > BYTE_LIMIT || queue.stream_items >= ITEM_LIMIT {
            return Ok(false);
        }
        queue.bytes += encoded.len();
        queue.items += 1;
        queue.stream_bytes += encoded.len();
        queue.stream_items += 1;
        queue.frames.push_back((encoded, true));
        self.shared.changed.notify_one();
        Ok(true)
    }

    /// Queues a streaming frame, waiting for window room until `deadline`; only then does it
    /// fall back to the overflow cancel. The check and the insert share one lock hold, so
    /// another PTY on the same connection cannot take the room in between.
    pub(in crate::supervisor) fn enqueue_stream_waiting(
        &self,
        frame: EncodedFrame,
        deadline: Instant,
    ) -> io::Result<()> {
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| io::Error::other("writer queue poisoned"))?;
        loop {
            if self.is_closed() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            if queue.stream_bytes + frame.len() <= BYTE_LIMIT && queue.stream_items < ITEM_LIMIT {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(queue);
                self.cancel();
                return Err(io::Error::other(
                    "subscriber window exhausted; reconnect required",
                ));
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining)
                .map_err(|_| io::Error::other("writer queue poisoned"))?
                .0;
        }
        queue.bytes += frame.len();
        queue.items += 1;
        queue.stream_bytes += frame.len();
        queue.stream_items += 1;
        queue.frames.push_back((frame, true));
        self.shared.changed.notify_one();
        Ok(())
    }
}

#[cfg(test)]
#[path = "writer.backpressure.tests.rs"]
mod tests;
