use super::close;
use bigbud_remote_agent::pty::PtyHandle;
use std::io;
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Instant;

/// The fixture's absolute lifetime cap, not an idle policy: this layer has no
/// trusted view state or remote foreground hint. A quiet SSH child may be busy.
pub(super) fn start(
    handle: Arc<PtyHandle>,
    reader_done: mpsc::Receiver<()>,
    expires_at: Instant,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("ssh-owner-pty-hard-expiry".into())
        .spawn(move || {
            // Budget from before the child launch, not from when this worker
            // gets scheduled. Reader loss also requests cleanup of this handle.
            let _reader_finished_or_expired =
                reader_done.recv_timeout(expires_at.saturating_duration_since(Instant::now()));
            // No close acknowledgement is sent by the watchdog. Status and
            // explicit revocation still require reaping the owned child.
            let _cleanup = close(&handle);
        })
}
