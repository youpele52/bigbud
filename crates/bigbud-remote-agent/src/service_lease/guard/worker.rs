//! Keep filesystem reads away from the monitor's child-cancellation loop.
use super::super::{Error, Result};
use super::{
    Guard,
    read::{Observation, Reader},
};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
#[derive(Default)]
struct Control {
    cancelled: bool,
    refresh: u64,
}
pub(crate) struct Worker {
    cancellation: Arc<(Mutex<Control>, Condvar)>,
    invalid: Arc<AtomicBool>,
    observations: mpsc::Receiver<(Instant, u64)>,
    last: Option<(Instant, u64)>,
    thread: Option<JoinHandle<()>>,
}
impl Worker {
    pub(crate) fn start(
        guard: Guard,
        assets: Option<super::super::AssetsResource>,
    ) -> Result<Self> {
        let mut reader = Reader::default();
        let mut tree = None;
        Self::start_read(move || {
            let observation = reader.check(&guard);
            if !matches!(observation, Observation::Valid) {
                return observation;
            }
            if let Some(assets) = &assets {
                if tree.is_none() {
                    match assets.watch() {
                        Ok(watch) => tree = Some(watch),
                        Err(_) => return Observation::Invalid,
                    }
                }
                if tree.as_ref().is_none_or(|watch| watch.check().is_err()) {
                    return Observation::Invalid;
                }
            }
            Observation::Valid
        })
    }
    fn start_read(mut read: impl FnMut() -> Observation + Send + 'static) -> Result<Self> {
        let cancellation = Arc::new((Mutex::new(Control::default()), Condvar::new()));
        let invalid = Arc::new(AtomicBool::new(false));
        let (sender, observations) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("lease-validity-reader".into())
            .spawn({
                let cancellation = Arc::clone(&cancellation);
                let invalid = Arc::clone(&invalid);
                move || loop {
                    let Ok(cancelled) = cancellation.0.lock() else {
                        invalid.store(true, Ordering::Release);
                        return;
                    };
                    if cancelled.cancelled {
                        return;
                    }
                    let requested = cancelled.refresh;
                    drop(cancelled);
                    let began = Instant::now();
                    match read() {
                        Observation::Valid => {
                            let _bounded_observation = sender.try_send((Instant::now(), requested));
                        }
                        Observation::Invalid => {
                            invalid.store(true, Ordering::Release);
                            return;
                        }
                        Observation::Retry => (),
                    }
                    let Ok(cancelled) = cancellation.0.lock() else {
                        invalid.store(true, Ordering::Release);
                        return;
                    };
                    if cancelled.refresh != requested {
                        drop(cancelled);
                        continue;
                    }
                    let Ok((cancelled, _)) = cancellation.1.wait_timeout_while(
                        cancelled,
                        Duration::from_secs(1).saturating_sub(began.elapsed()),
                        |control| !control.cancelled && control.refresh == requested,
                    ) else {
                        invalid.store(true, Ordering::Release);
                        return;
                    };
                    if cancelled.cancelled {
                        return;
                    }
                }
            })?;
        Ok(Self {
            cancellation,
            invalid,
            observations,
            last: None,
            thread: Some(thread),
        })
    }
    pub(crate) fn invalid(&self) -> bool {
        self.invalid.load(Ordering::Acquire)
    }
    pub(crate) fn fresh(&mut self) -> bool {
        while let Ok(observed) = self.observations.try_recv() {
            self.last = Some(observed);
        }
        !self.invalid()
            && self
                .last
                .is_some_and(|(at, _)| at.elapsed() <= Duration::from_secs(2))
    }
    pub(crate) fn request_refresh(&mut self) -> Result<u64> {
        self.fresh();
        let mut control = self.cancellation.0.lock().map_err(|_| Error::Uncertain)?;
        if control.cancelled {
            return Err(Error::Uncertain);
        }
        control.refresh = control.refresh.checked_add(1).ok_or(Error::Uncertain)?;
        let target = control.refresh;
        drop(control);
        self.cancellation.1.notify_all();
        Ok(target)
    }
    pub(crate) fn refreshed(&mut self, target: u64) -> bool {
        self.fresh() && self.last.is_some_and(|(_, observed)| observed >= target)
    }
    pub(crate) fn finish(&mut self) -> Result<()> {
        self.cancellation
            .0
            .lock()
            .map_err(|_| Error::Uncertain)?
            .cancelled = true;
        self.cancellation.1.notify_all();
        let deadline = Instant::now() + Duration::from_millis(500);
        while self
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            if Instant::now() >= deadline {
                return Err(Error::Uncertain);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| Error::Uncertain)?;
        }
        Ok(())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _owned_join = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[allow(clippy::unwrap_used)]
    fn stalled_reader_cannot_block_monitor_freshness_or_claim_settlement() {
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered, observed) = mpsc::sync_channel(1);
        let mut worker = Worker::start_read({
            let release = Arc::clone(&release);
            move || {
                entered.send(()).unwrap();
                let lock = release.0.lock().unwrap();
                let _released = release.1.wait_while(lock, |released| !*released).unwrap();
                Observation::Valid
            }
        })
        .unwrap();
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        let start = Instant::now();
        assert!(!worker.fresh());
        assert!(matches!(worker.finish(), Err(Error::Uncertain)));
        assert!(start.elapsed() < Duration::from_secs(1));
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        worker.finish().unwrap();
    }
    #[test]
    #[allow(clippy::unwrap_used)]
    fn refresh_never_accepts_an_observation_started_before_its_request() {
        let (entered, seen) = mpsc::sync_channel(1);
        let (release, released) = mpsc::sync_channel(1);
        let mut count = 0;
        let mut worker = Worker::start_read(move || {
            let current = count;
            count += 1;
            entered.send(current).unwrap();
            released.recv_timeout(Duration::from_secs(2)).unwrap();
            Observation::Valid
        })
        .unwrap();
        assert_eq!(seen.recv_timeout(Duration::from_secs(1)).unwrap(), 0);
        let target = worker.request_refresh().unwrap();
        release.send(()).unwrap();
        assert_eq!(seen.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert!(
            !worker.refreshed(target),
            "old read completed after request but cannot authorize it"
        );
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !worker.refreshed(target) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        worker.finish().unwrap();
    }
}
