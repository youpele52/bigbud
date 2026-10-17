use crate::collector::CollectionError;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_FAILURES: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CollectionState {
    Healthy,
    Retrying {
        attempts: u8,
        next_retry_at: Instant,
        reason: CollectionError,
    },
    Failed {
        reason: CollectionError,
    },
}

pub(crate) struct Recovery {
    failures: VecDeque<Instant>,
    state: CollectionState,
}

impl Default for Recovery {
    fn default() -> Self {
        Self {
            failures: VecDeque::with_capacity(MAX_FAILURES),
            state: CollectionState::Healthy,
        }
    }
}

impl Recovery {
    pub(crate) fn state(&self) -> CollectionState {
        self.state
    }

    pub(crate) fn can_sample(&self, now: Instant) -> bool {
        match self.state {
            CollectionState::Healthy => true,
            CollectionState::Retrying { next_retry_at, .. } => now >= next_retry_at,
            CollectionState::Failed { .. } => false,
        }
    }

    pub(crate) fn success(&mut self) {
        self.state = CollectionState::Healthy;
    }

    pub(crate) fn failure(&mut self, now: Instant, reason: CollectionError) {
        while self
            .failures
            .front()
            .is_some_and(|old| now.saturating_duration_since(*old) >= WINDOW)
        {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        let attempts = self.failures.len();
        self.state = if attempts >= MAX_FAILURES {
            CollectionState::Failed { reason }
        } else {
            let delay = Duration::from_secs(attempts as u64);
            CollectionState::Retrying {
                attempts: attempts as u8,
                next_retry_at: now + delay,
                reason,
            }
        };
    }

    pub(crate) fn retry(&mut self) {
        self.failures.clear();
        self.state = CollectionState::Healthy;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn three_failures_in_a_minute_require_explicit_retry() {
        let at = Instant::now();
        let mut recovery = Recovery::default();
        recovery.failure(at, CollectionError::MissingCpu);
        assert!(!recovery.can_sample(at));
        assert!(recovery.can_sample(at + Duration::from_secs(1)));
        recovery.failure(at + Duration::from_secs(1), CollectionError::MissingMemory);
        assert!(!recovery.can_sample(at + Duration::from_secs(2)));
        assert!(recovery.can_sample(at + Duration::from_secs(3)));
        recovery.failure(at + Duration::from_secs(3), CollectionError::MissingMemory);
        assert_eq!(
            recovery.state(),
            CollectionState::Failed {
                reason: CollectionError::MissingMemory
            }
        );
        assert!(!recovery.can_sample(at + Duration::from_secs(100)));
        recovery.retry();
        assert_eq!(recovery.state(), CollectionState::Healthy);
        assert!(recovery.can_sample(at + Duration::from_secs(100)));
    }

    #[test]
    fn old_failures_expire_from_bounded_window() {
        let at = Instant::now();
        let mut recovery = Recovery::default();
        recovery.failure(at, CollectionError::MissingCpu);
        recovery.success();
        recovery.failure(at + Duration::from_secs(60), CollectionError::MissingMemory);
        assert_eq!(
            recovery.state(),
            CollectionState::Retrying {
                attempts: 1,
                next_retry_at: at + Duration::from_secs(61),
                reason: CollectionError::MissingMemory,
            }
        );
    }
}
