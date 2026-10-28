use super::DurableRoot;
use crate::native_fs::storage;
use std::{
    fs::{File, TryLockError},
    io,
    sync::Mutex,
};

#[derive(Debug)]
pub enum LockError {
    Conflict,
    InvalidRoot,
    Io(io::Error),
}
/// Lock lifetime owns the complete validated root and the journal inode. Neither
/// path-only constructors nor caller assertions can produce production evidence.
/// This is storage election, NOT interactive-session election or admission.
///
/// ```compile_fail
/// use bigbud_computer_use::guard::ControllingLock;
/// let lock = ControllingLock::acquire_in_verified_directory(std::path::Path::new("/arbitrary"));
/// ```
/// ```compile_fail
/// use bigbud_computer_use::guard::ControllingLock;
/// fn release_early(lock: ControllingLock) {
///     let journal = lock.journal();
///     drop(lock);
///     let _ = journal.read();
/// }
/// ```
#[derive(Debug)]
pub struct ControllingLock {
    pub(super) root: DurableRoot,
    file: File,
    pub(super) journal_file: Mutex<Option<File>>,
    /// Launch-permit fence shared by every recovery under this election.
    /// Creating or dropping a recovery, every quiesce and dropping the
    /// election advance it, so a permit never outlives the recovery/election
    /// that issued it. Only quiesce (which holds the `LaunchGuard`) is
    /// linearised with an in-progress spawn; permits are `!Send`, so issue,
    /// fence checks and spawn stay on the issuing thread.
    pub(crate) launch_fence: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
impl Drop for ControllingLock {
    fn drop(&mut self) {
        self.launch_fence
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}
impl ControllingLock {
    pub(super) fn acquire(root: DurableRoot) -> Result<Self, LockError> {
        root.validate().map_err(LockError::Io)?;
        let directory = root.directory();
        // Create exclusively; an existing object is separately opened without
        // truncation and validated. Never unlink/recreate a lock on conflict.
        let (file, created) = match storage::open(
            directory,
            c"controller.lock",
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        ) {
            Ok(file) => (file, true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (
                storage::open(directory, c"controller.lock", libc::O_RDWR)
                    .map_err(LockError::Io)?,
                false,
            ),
            Err(error) => return Err(LockError::Io(error)),
        };
        storage::validate(directory, c"controller.lock", &file, root.uid())
            .map_err(LockError::Io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(LockError::Conflict),
            Err(TryLockError::Error(error)) => return Err(LockError::Io(error)),
        }
        root.validate().map_err(LockError::Io)?;
        storage::validate(directory, c"controller.lock", &file, root.uid())
            .map_err(LockError::Io)?;
        if created {
            file.sync_all().map_err(LockError::Io)?;
            directory.sync_all().map_err(LockError::Io)?;
        }
        let journal =
            storage::optional(directory, c"safety.v1", root.uid()).map_err(LockError::Io)?;
        let result = Self {
            root,
            file,
            journal_file: Mutex::new(journal),
            launch_fence: std::sync::Arc::default(),
        };
        result.validate().map_err(LockError::Io)?;
        Ok(result)
    }

    pub fn validate(&self) -> io::Result<()> {
        self.root.validate()?;
        storage::validate(
            self.root.directory(),
            c"controller.lock",
            &self.file,
            self.root.uid(),
        )
    }

    pub fn journal(&self) -> super::Journal<'_> {
        super::Journal::for_lock(self)
    }

    // Compatibility for existing deterministic model fixtures only, never a
    // production "verified" path assertion. Fixture ancestors aren't authority.
    #[cfg(test)]
    pub fn acquire_in_verified_directory(path: &std::path::Path) -> Result<Self, LockError> {
        let root = DurableRoot::fixture(path, false).map_err(|_| LockError::InvalidRoot)?;
        Self::acquire(root).map_err(|error| match error {
            LockError::Conflict => LockError::Conflict,
            _ => LockError::InvalidRoot,
        })
    }
}
