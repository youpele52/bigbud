use super::OutboundWriter;
use std::io;
use std::sync::TryLockError;
use std::time::{Duration, Instant};

impl OutboundWriter {
    /// Terminal ownership makes this deadline permanent for every cleanup path.
    pub(in crate::supervisor::core) fn fence_join_deadline(
        &self,
        deadline: Instant,
    ) -> io::Result<()> {
        let mut terminal = self
            .terminal_join_deadline
            .lock()
            .map_err(|_| io::Error::other("writer terminal deadline poisoned"))?;
        *terminal = Some(terminal.map_or(deadline, |previous| previous.min(deadline)));
        Ok(())
    }

    pub(in crate::supervisor::core) fn join(&self) -> io::Result<()> {
        self.join_until(Instant::now() + Duration::from_millis(500))
    }

    pub(in crate::supervisor::core) fn join_until(
        &self,
        requested_deadline: Instant,
    ) -> io::Result<()> {
        self.cancel();
        loop {
            let deadline = self
                .terminal_join_deadline
                .lock()
                .map_err(|_| io::Error::other("writer terminal deadline poisoned"))?
                .map_or(requested_deadline, |terminal| {
                    terminal.min(requested_deadline)
                });
            match self.worker.try_lock() {
                Ok(mut slot) => match slot.as_ref() {
                    None => return Ok(()),
                    Some(worker) if worker.is_finished() => {
                        let worker = slot.take();
                        drop(slot);
                        if let Some(worker) = worker {
                            // is_finished covers the entire thread, including
                            // permit/closure drops, not an earlier notification.
                            return worker
                                .join()
                                .map_err(|_| io::Error::other("writer panicked"));
                        }
                    }
                    Some(_) => {}
                },
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Poisoned(_)) => {
                    return Err(io::Error::other("writer worker poisoned"));
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::other("writer shutdown unconfirmed"));
            }
            // Do not hold a worker lock across waits: concurrent connection
            // cleanup observes the same fence and cannot hide a fresh timeout.
            std::thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }
}

impl Drop for OutboundWriter {
    fn drop(&mut self) {
        if self.join().is_err() {
            eprintln!("subscriber writer shutdown unconfirmed");
        }
    }
}
