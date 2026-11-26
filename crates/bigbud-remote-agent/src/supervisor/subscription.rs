use super::writer::{OutboundWriter, budget};
use bigbud_protocol::v1;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Bounded live suffix held while an attach replays (unchanged limits).
const HANDOFF_BYTES: usize = 256 * 1024;
const HANDOFF_ITEMS: usize = 256;

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
        self.deliver_with(frame, None)
    }

    /// PTY output: waits (until `deadline`) for budget and window room instead of failing at
    /// once. The PTY gate already waited for room, so this wait is short and rare.
    pub fn deliver_paced(&self, frame: &v1::Frame, deadline: Instant) -> io::Result<()> {
        self.deliver_with(frame, Some(deadline))
    }

    /// Whether one more output frame of `bytes` fits, waiting until `deadline` for a live
    /// subscriber's window to drain. A replay handoff's bounded suffix is checked, not awaited.
    pub fn wait_room(&self, bytes: usize, deadline: Instant) -> bool {
        let replay_room = match self.phase.lock() {
            Ok(phase) => match &*phase {
                Phase::Replay {
                    bytes: held,
                    pending,
                    ..
                } => Some(*held + bytes <= HANDOFF_BYTES && pending.len() < HANDOFF_ITEMS),
                Phase::Live { .. } => None,
                Phase::Closed => return true,
            },
            Err(_) => return true,
        };
        match replay_room {
            Some(room) => {
                if !room {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    std::thread::sleep(remaining.min(Duration::from_millis(5)));
                }
                room
            }
            None => self.writer.wait_stream_room(bytes, deadline),
        }
    }

    fn deliver_with(&self, frame: &v1::Frame, paced: Option<Instant>) -> io::Result<()> {
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
        let encoded = match paced {
            Some(deadline) => budget::encode_waiting(frame, 256 * 1024 - 4, deadline)?,
            None => budget::encode(frame, 256 * 1024 - 4)?,
        };
        match &mut *phase {
            Phase::Replay { bytes, pending, .. } => {
                if *bytes + encoded.len() > HANDOFF_BYTES || pending.len() >= HANDOFF_ITEMS {
                    *phase = Phase::Closed;
                    self.writer.cancel(); // Explicit disconnect: never splice a missing suffix.
                    return Err(io::Error::other("replay handoff suffix exhausted"));
                }
                *bytes += encoded.len();
                pending.push_back(encoded);
            }
            Phase::Live { cut } => {
                match paced {
                    Some(deadline) => self.writer.enqueue_stream_waiting(encoded, deadline)?,
                    None => self.writer.enqueue_encoded(encoded, true)?,
                }
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
        // Other PTYs' output may share this connection's window; wait for it to drain rather
        // than dropping a handoff that is otherwise complete.
        let deadline = Instant::now() + Duration::from_secs(5);
        for frame in pending {
            self.writer.enqueue_stream_waiting(frame, deadline)?;
        }
        *phase = Phase::Live { cut };
        Ok(())
    }
}
