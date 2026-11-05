/// Pure state of an independently serviced authenticated parent/control pipe.
/// This is NOT an OS watcher. The future transport must read real pipe progress
/// on a separate thread and supply a suspend-inclusive monotonic clock. Neither
/// a worker response nor a main-process timer is evidence of renderer health.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifelineState {
    Live,
    Lost,
}

pub struct Lifeline {
    generation: String,
    sequence: u64,
    last_time_ms: u64,
    expires_ms: u64,
    timeout_ms: u64,
    state: LifelineState,
}
impl Lifeline {
    pub fn new(generation: String, now_ms: u64, timeout_ms: u64) -> Option<Self> {
        if !crate::guard::record::valid_id(&generation) || timeout_ms == 0 || timeout_ms > 750 {
            return None;
        }
        Some(Self {
            generation,
            sequence: 0,
            last_time_ms: now_ms,
            expires_ms: now_ms.checked_add(timeout_ms)?,
            timeout_ms,
            state: LifelineState::Live,
        })
    }
    /// A duplicate/stale sequence cannot extend a deadline. A lost lifeline can
    /// only be replaced by a new supervised generation, never silently revived.
    pub fn progress(&mut self, generation: &str, sequence: u64, now_ms: u64) -> bool {
        if self.check(now_ms) == LifelineState::Lost {
            return false;
        }
        if generation != self.generation || sequence <= self.sequence {
            return false;
        }
        let Some(deadline) = now_ms.checked_add(self.timeout_ms) else {
            self.state = LifelineState::Lost;
            return false;
        };
        self.sequence = sequence;
        self.expires_ms = deadline;
        true
    }
    pub fn eof(&mut self) {
        self.state = LifelineState::Lost;
    }
    pub fn check(&mut self, now_ms: u64) -> LifelineState {
        if now_ms < self.last_time_ms || now_ms >= self.expires_ms {
            self.state = LifelineState::Lost;
        }
        self.last_time_ms = now_ms;
        self.state
    }
}
