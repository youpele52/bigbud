use std::{
    fs::{File, OpenOptions, TryLockError},
    io,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub enum LockError {
    Conflict,
    InvalidRoot,
    Io(io::Error),
}
/// One OS-exclusive lock per verified private per-user directory. The caller
/// must qualify directory ownership/ACLs before using this as a desktop root.
/// Never remove/replace the lock file while held; Drop closes the owning handle.
#[derive(Debug)]
pub struct ControllingLock {
    _file: File,
    pub(super) directory: PathBuf,
}
impl ControllingLock {
    pub fn journal(&self) -> super::Journal<'_> {
        super::Journal::for_lock(self)
    }

    pub fn acquire_in_verified_directory(directory: &Path) -> Result<Self, LockError> {
        let metadata = std::fs::symlink_metadata(directory).map_err(LockError::Io)?;
        if !directory.is_absolute() || !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(LockError::InvalidRoot);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid takes no pointers and has no failure result.
            let uid = unsafe { libc::geteuid() };
            if metadata.mode() & 0o077 != 0 || metadata.uid() != uid {
                return Err(LockError::InvalidRoot);
            }
        }
        let path = directory.join("controller.lock");
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && (!metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(LockError::InvalidRoot);
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        let file = options.open(&path).map_err(LockError::Io)?;
        let opened = file.metadata().map_err(LockError::Io)?;
        let named = std::fs::symlink_metadata(&path).map_err(LockError::Io)?;
        if !opened.is_file() || !named.is_file() {
            return Err(LockError::InvalidRoot);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o077 != 0
                || opened.mode() & 0o077 != 0
                || opened.uid() != metadata.uid()
                || opened.nlink() != 1
                || opened.dev() != named.dev()
                || opened.ino() != named.ino()
            {
                return Err(LockError::InvalidRoot);
            }
        }
        match file.try_lock() {
            Ok(()) => Ok(Self {
                _file: file,
                directory: directory.to_path_buf(),
            }),
            Err(TryLockError::WouldBlock) => Err(LockError::Conflict),
            Err(TryLockError::Error(error)) => Err(LockError::Io(error)),
        }
    }
}
