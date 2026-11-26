//! Paced, lazy snapshot frames (plan §9.1, N3). A snapshot header or chunk is encoded only once
//! the response queue has room for it and the transfer's previous frame has been written, so a
//! transfer holds at most one encoded chunk, never waits on a full queue long enough to trip the
//! 5 s response cancel, and never cancels the connection: a missed deadline abandons only the
//! transfer (the client retries after its own 5 s timeout).

use super::budget::{self, TransferSlot};
use super::{ITEM_LIMIT, OutboundWriter};
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, encoded_frame_length, v1};
use std::io;
use std::sync::Arc;
use std::time::Instant;

impl OutboundWriter {
    pub(in crate::supervisor) fn enqueue_snapshot(
        &self,
        frame: &v1::Frame,
        slot: &Arc<TransferSlot>,
        deadline: Instant,
    ) -> io::Result<()> {
        slot.wait_idle(deadline)?;
        let size =
            encoded_frame_length(frame, DEFAULT_MAX_FRAME_BYTES).map_err(io::Error::other)?;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| io::Error::other("writer queue poisoned"))?;
        loop {
            if self.is_closed() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            let full = queue.bytes - queue.stream_bytes + size > DEFAULT_MAX_FRAME_BYTES + 4
                || queue.items - queue.stream_items >= ITEM_LIMIT;
            if !full {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining)
                .map_err(|_| io::Error::other("writer queue poisoned"))?
                .0;
        }
        // Encoded under the queue lock so the room just observed is still there.
        let encoded = budget::encode_for_transfer(frame, DEFAULT_MAX_FRAME_BYTES, slot)?;
        queue.bytes += encoded.len();
        queue.items += 1;
        queue.frames.push_back((encoded, false));
        self.shared.changed.notify_one();
        Ok(())
    }
}
