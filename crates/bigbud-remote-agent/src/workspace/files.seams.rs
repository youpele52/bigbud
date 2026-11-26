//! Test seams for the Unix write path. Every function is a no-op in production builds; under
//! `cfg(test)` a test on the same thread can stand in for a racing writer, a corrupting
//! filesystem, an unsupported lock, or a shortened lock deadline.

use std::fs::File;
use std::time::Duration;

/// Points at which a test can inject an `errno`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    /// `flock` on the parent directory (for example `EBADF` on Linux NFS).
    DirectoryLock,
    /// `fchown` of the temporary file to the original group.
    TemporaryChown,
    /// Immediately after an in-place write truncated the target.
    AfterTruncate,
}

#[cfg(test)]
type CommitHook = Box<dyn FnOnce()>;
#[cfg(test)]
type SyncHook = Box<dyn for<'file> FnOnce(&'file File)>;

#[cfg(test)]
thread_local! {
    pub(super) static BEFORE_COMMIT_HOOK: std::cell::RefCell<Option<CommitHook>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static AFTER_SYNC_HOOK: std::cell::RefCell<Option<SyncHook>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static FAULTS: std::cell::RefCell<Vec<(Fault, i32)>> =
        const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static LOCK_TIMEOUT: std::cell::Cell<Option<Duration>> =
        const { std::cell::Cell::new(None) };
}

/// Runs after the first hash check, immediately before the commit re-check.
pub(super) fn before_commit() {
    #[cfg(test)]
    BEFORE_COMMIT_HOOK.with(|hook| {
        let installed = hook.borrow_mut().take();
        if let Some(hook) = installed {
            hook();
        }
    });
}

/// Runs after written bytes were fsynced and before they are read back.
pub(super) fn after_sync(file: &File) {
    #[cfg(test)]
    AFTER_SYNC_HOOK.with(|hook| {
        let installed = hook.borrow_mut().take();
        if let Some(hook) = installed {
            hook(file);
        }
    });
    #[cfg(not(test))]
    let _ = file;
}

/// The injected error for `fault`, if a test installed one.
pub(super) fn injected(fault: Fault) -> Option<std::io::Error> {
    #[cfg(test)]
    {
        FAULTS.with(|faults| {
            faults
                .borrow()
                .iter()
                .find(|(installed, _)| *installed == fault)
                .map(|(_, errno)| std::io::Error::from_raw_os_error(*errno))
        })
    }
    #[cfg(not(test))]
    {
        let _ = fault;
        None
    }
}

/// The write-lock deadline: `default` in production.
pub(super) fn lock_timeout(default: Duration) -> Duration {
    #[cfg(test)]
    {
        LOCK_TIMEOUT
            .with(|timeout| timeout.get())
            .unwrap_or(default)
    }
    #[cfg(not(test))]
    {
        default
    }
}
