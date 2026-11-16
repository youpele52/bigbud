use crate::operations::OutputStream;
use std::sync::mpsc::{self, Receiver, SendError, SyncSender};

// Independent of the runner's read size: future larger callbacks are split.
// Tiny writes cannot consume unbounded queue metadata either.
const MAX_CHUNK_BYTES: usize = 16 * 1024;
const QUEUE_ITEMS: usize = 16;
type Chunk = (OutputStream, Vec<u8>);

pub(super) struct OutputSender(SyncSender<Chunk>);

pub(super) fn channel() -> (OutputSender, Receiver<Chunk>) {
    let (sender, receiver) = mpsc::sync_channel(QUEUE_ITEMS);
    (OutputSender(sender), receiver)
}

impl OutputSender {
    /// Lossless backpressure, with <=256KiB queued per process. Each of the
    /// runner's two output readers can additionally hold one <=16KiB chunk
    /// waiting to send; the consumer holds at most one dequeued chunk. These
    /// bounds do not include the runner's separate retained result buffers.
    ///
    /// Never called under session/subscriber locks. Cancellation and timeout
    /// polling happen on the runner thread, independently of these readers.
    /// Do not abandon queued output on cancellation or move the runner join
    /// ahead of draining: either would lose output or deadlock a full queue.
    pub(super) fn send(&self, stream: OutputStream, bytes: &[u8]) -> Result<(), SendError<Chunk>> {
        for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
            self.0.send((stream, chunk.to_vec()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "jobs.output.tests.rs"]
mod tests;
