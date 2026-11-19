use std::thread::JoinHandle;

use super::registry::SearchRegistry;

/// Search worker threads started by one connection (stdio session or supervisor connection).
/// Owning them here gives every worker an explicit cancellation and join path: when the
/// connection ends, its searches are cancelled and joined (cancellation is observed within a
/// file or a match, so the join is short).
#[derive(Debug)]
pub struct SearchWorkers {
    registry: SearchRegistry,
    running: Vec<(String, JoinHandle<()>)>,
}

impl SearchWorkers {
    pub fn new(registry: SearchRegistry) -> Self {
        Self {
            registry,
            running: Vec::new(),
        }
    }

    /// Starts `work` on a named thread for `operation_id`. Finished workers are reaped first.
    pub fn spawn(
        &mut self,
        operation_id: String,
        work: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<()> {
        self.reap_finished();
        let handle = std::thread::Builder::new()
            .name("bigbud-search".to_owned())
            .spawn(work)?;
        self.running.push((operation_id, handle));
        Ok(())
    }

    fn reap_finished(&mut self) {
        let (finished, running): (Vec<_>, Vec<_>) = std::mem::take(&mut self.running)
            .into_iter()
            .partition(|(_, handle)| handle.is_finished());
        self.running = running;
        for (_, handle) in finished {
            // A panicking search worker already lost its result; the panic must not take the
            // connection down with it.
            let _joined = handle.join();
        }
    }

    pub fn running(&self) -> usize {
        self.running
            .iter()
            .filter(|(_, handle)| !handle.is_finished())
            .count()
    }

    /// Cancels this connection's searches and joins their threads.
    pub fn cancel_and_join(&mut self) {
        for (operation_id, _) in &self.running {
            let _was_running = self.registry.cancel(operation_id);
        }
        for (_, handle) in self.running.drain(..) {
            let _joined = handle.join();
        }
    }
}

impl Drop for SearchWorkers {
    fn drop(&mut self) {
        self.cancel_and_join();
    }
}
