use super::writer::{OutboundWriter, budget};
use bigbud_protocol::v1;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};

enum Phase {
    Replay {
        cut: u64,
        bytes: usize,
        pending: VecDeque<budget::EncodedFrame>,
    },
    Live {
        cut: u64,
    },
    Closed,
}

/// Each attach owns a distinct handoff generation. Its bounded suffix cannot
/// overtake paced replay; late broadcasts already included at the cut are ignored.
pub(in crate::supervisor) struct Subscription {
    pub writer: Arc<OutboundWriter>,
    phase: Mutex<Phase>,
}
fn sequence(frame: &v1::Frame) -> Option<u64> {
    match &frame.payload {
        Some(v1::frame::Payload::PtyOutput(value)) => Some(value.sequence),
        Some(v1::frame::Payload::ProcessOutput(value)) => Some(value.sequence),
        _ => None,
    }
}
impl Subscription {
    pub fn live(writer: Arc<OutboundWriter>) -> Arc<Self> {
        Arc::new(Self {
            writer,
            phase: Mutex::new(Phase::Live { cut: 0 }),
        })
    }
    pub fn replay(writer: Arc<OutboundWriter>, cut: u64) -> Arc<Self> {
        Arc::new(Self {
            writer,
            phase: Mutex::new(Phase::Replay {
                cut,
                bytes: 0,
                pending: VecDeque::new(),
            }),
        })
    }
    pub fn close(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            *phase = Phase::Closed;
        }
    }
    pub fn deliver(&self, frame: &v1::Frame) -> io::Result<()> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| io::Error::other("subscription poisoned"))?;
        let cut = match &*phase {
            Phase::Replay { cut, .. } | Phase::Live { cut } => *cut,
            Phase::Closed => return Ok(()),
        };
        if sequence(frame).is_some_and(|sequence| sequence <= cut) {
            return Ok(());
        }
        let encoded = budget::encode(frame, 256 * 1024 - 4)?;
        match &mut *phase {
            Phase::Replay { bytes, pending, .. } => {
                if *bytes + encoded.len() > 256 * 1024 || pending.len() >= 256 {
                    *phase = Phase::Closed;
                    self.writer.cancel(); // Explicit disconnect: never splice a missing suffix.
                    return Err(io::Error::other("replay handoff suffix exhausted"));
                }
                *bytes += encoded.len();
                pending.push_back(encoded);
            }
            Phase::Live { cut } => {
                self.writer.enqueue_encoded(encoded, true)?;
                if let Some(sequence) = sequence(frame) {
                    *cut = sequence;
                }
            }
            Phase::Closed => {}
        }
        Ok(())
    }
    pub fn finish_replay(&self) -> io::Result<()> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| io::Error::other("subscription poisoned"))?;
        let old = std::mem::replace(&mut *phase, Phase::Closed);
        let Phase::Replay { cut, pending, .. } = old else {
            return Err(io::Error::other("handoff generation closed"));
        };
        // Producer admission is held only for bounded nonblocking queue moves,
        // never for socket/pacing waits. Replay frames are already in the FIFO.
        for frame in pending {
            self.writer.enqueue_encoded(frame, true)?;
        }
        *phase = Phase::Live { cut };
        Ok(())
    }
}
