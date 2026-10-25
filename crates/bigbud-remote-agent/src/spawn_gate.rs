use std::io;
use std::sync::{Mutex, MutexGuard};

static SPAWN: Mutex<()> = Mutex::new(());

/// Every production fork/exec path in this process shares this gate. PTY master
/// creation through CLOEXEC setup is atomic relative to Command::spawn. The
/// post-fork child never drops/locks this inherited mutex: it execs or _exits.
pub(crate) fn lock() -> io::Result<MutexGuard<'static, ()>> {
    SPAWN
        .lock()
        .map_err(|_| io::Error::other("process spawn gate poisoned"))
}
