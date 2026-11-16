//! Sliding-window limits for pairing exchange attempts.
//!
//! Every request arrives from Tailscale Serve on loopback, so per-address
//! limits would be meaningless. Attempts are limited per pairing ID instead, so
//! a tailnet peer without a pairing's link cannot exhaust that pairing's
//! attempts, plus a higher global window that bounds total throughput. The map
//! of tracked IDs is bounded; attempts for new IDs beyond it are refused until
//! old entries age out.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
struct Windows {
    global: VecDeque<Instant>,
    per_id: HashMap<String, VecDeque<Instant>>,
}

#[derive(Debug)]
pub struct PairingLimiter {
    per_id_capacity: usize,
    global_capacity: usize,
    max_tracked_ids: usize,
    window: Duration,
    windows: Mutex<Windows>,
}

fn prune(attempts: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while attempts.front().is_some_and(|first| {
        now.checked_duration_since(*first)
            .is_some_and(|age| age >= window)
    }) {
        attempts.pop_front();
    }
}

impl PairingLimiter {
    pub fn new(
        per_id_capacity: usize,
        global_capacity: usize,
        max_tracked_ids: usize,
        window: Duration,
    ) -> Self {
        Self {
            per_id_capacity,
            global_capacity,
            max_tracked_ids,
            window,
            windows: Mutex::new(Windows::default()),
        }
    }

    /// Records an attempt for `pairing_id` at `now` and returns whether it is
    /// allowed. A refused attempt is not recorded.
    pub fn try_acquire_at(&self, pairing_id: &str, now: Instant) -> bool {
        // A poisoned lock only means another thread panicked mid-update; the
        // timestamps are still structurally valid, so keep limiting.
        let mut windows = match self.windows.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let window = self.window;
        prune(&mut windows.global, now, window);
        if windows.global.len() >= self.global_capacity {
            return false;
        }
        if !windows.per_id.contains_key(pairing_id) {
            // Drop IDs whose attempts have all aged out before refusing a new one.
            windows.per_id.retain(|_, attempts| {
                prune(attempts, now, window);
                !attempts.is_empty()
            });
            if windows.per_id.len() >= self.max_tracked_ids {
                return false;
            }
        }
        let attempts = windows.per_id.entry(pairing_id.to_owned()).or_default();
        prune(attempts, now, window);
        if attempts.len() >= self.per_id_capacity {
            return false;
        }
        attempts.push_back(now);
        windows.global.push_back(now);
        true
    }

    pub fn try_acquire(&self, pairing_id: &str) -> bool {
        self.try_acquire_at(pairing_id, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn limits_one_pairing_within_the_window_and_recovers_after_it() {
        let limiter = PairingLimiter::new(2, 10, 8, MINUTE);
        let start = Instant::now();
        assert!(limiter.try_acquire_at("a", start));
        assert!(limiter.try_acquire_at("a", start + Duration::from_secs(1)));
        assert!(!limiter.try_acquire_at("a", start + Duration::from_secs(2)));
        assert!(limiter.try_acquire_at("a", start + Duration::from_secs(61)));
    }

    #[test]
    fn attempts_on_other_ids_do_not_lock_out_a_pairing() {
        let limiter = PairingLimiter::new(2, 100, 64, MINUTE);
        let start = Instant::now();
        for _ in 0..5 {
            limiter.try_acquire_at("guessed", start);
        }
        assert!(limiter.try_acquire_at("real", start));
    }

    #[test]
    fn global_window_bounds_total_attempts() {
        let limiter = PairingLimiter::new(5, 3, 64, MINUTE);
        let start = Instant::now();
        assert!(limiter.try_acquire_at("a", start));
        assert!(limiter.try_acquire_at("b", start));
        assert!(limiter.try_acquire_at("c", start));
        assert!(!limiter.try_acquire_at("d", start));
        assert!(limiter.try_acquire_at("d", start + MINUTE));
    }

    #[test]
    fn tracked_ids_are_bounded_and_aged_out() {
        let limiter = PairingLimiter::new(5, 100, 2, MINUTE);
        let start = Instant::now();
        assert!(limiter.try_acquire_at("a", start));
        assert!(limiter.try_acquire_at("b", start));
        assert!(!limiter.try_acquire_at("c", start));
        // A tracked ID still gets its own attempts while the map is full.
        assert!(limiter.try_acquire_at("a", start));
        assert!(limiter.try_acquire_at("c", start + MINUTE));
    }
}
