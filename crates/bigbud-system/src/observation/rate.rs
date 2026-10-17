use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Default)]
pub struct CounterRate {
    previous: Option<(u64, Instant)>,
}

impl CounterRate {
    /// Returns bytes/s. The first sample and a reset or wrap require a new baseline.
    pub fn sample(&mut self, total: u64, now: Instant) -> Option<f64> {
        let result = self.previous.and_then(|(old, at)| {
            let elapsed = now.checked_duration_since(at)?;
            if elapsed.is_zero() || elapsed > Duration::from_secs(30) || total < old {
                return None;
            }
            Some((total - old) as f64 / elapsed.as_secs_f64())
        });
        self.previous = Some((total, now));
        result
    }

    pub fn clear(&mut self) {
        self.previous = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn warmup_reset_and_units() {
        let at = Instant::now();
        let mut rate = CounterRate::default();
        assert_eq!(rate.sample(100, at), None);
        assert_eq!(rate.sample(300, at + Duration::from_secs(2)), Some(100.0));
        assert_eq!(rate.sample(10, at + Duration::from_secs(3)), None);
        assert_eq!(rate.sample(30, at + Duration::from_secs(4)), Some(20.0));
        assert_eq!(rate.sample(40, at + Duration::from_secs(40)), None);
    }
}
