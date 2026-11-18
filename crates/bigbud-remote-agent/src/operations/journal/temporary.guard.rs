use std::ffi::{CStr, CString};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use super::{MAGIC, OperationJournalError, Result};

const MAX_DIRECTORY_ENTRIES: usize = 4096;

/// The lock inode is NEVER renamed/unlinked. Each transaction opens a fresh
/// description, so flock also excludes another handle/thread in this process.
pub(in crate::operations::journal) struct Guard {
    pub(super) directory: File,
    pub(super) basename: CString,
    lock_name: CString,
    lock: File,
}

impl Guard {
    pub(in crate::operations::journal) fn acquire(path: &Path) -> Result<Self> {
        // Relative filenames deliberately resolve in the current directory.
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let basename = CString::new(
            path.file_name()
                .ok_or(OperationJournalError::Corrupt("journal filename absent"))?
                .as_bytes(),
        )
        .map_err(|_| OperationJournalError::Corrupt("invalid journal filename"))?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)?;
        let metadata = directory.metadata()?;
        // SAFETY: geteuid only observes the current account identity.
        let uid = unsafe { libc::geteuid() };
        // Normal runtime directories are private. Owner-controlled directories
        // and system sticky temp directories also support existing journal API
        // fixtures; other accounts cannot replace our owned entries there.
        let sticky =
            metadata.mode() & 0o1000 != 0 && (metadata.uid() == 0 || metadata.uid() == uid);
        if (metadata.uid() != uid || metadata.mode() & 0o022 != 0) && !sticky {
            return Err(OperationJournalError::CompactionDeferred(
                "journal directory is not owner-controlled",
            ));
        }
        let lock_name = sibling(&basename, b".lock")?;
        let lock = open_file(&directory, &lock_name, true, false)?;
        if lock.metadata()?.len() != 0 {
            return Err(OperationJournalError::CompactionDeferred(
                "journal guard has unexpected contents",
            ));
        }
        // SAFETY: lock is an owned regular file. Nonblocking admission never
        // waits under a session lock or recursively acquires another transaction.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let guard = Self {
            directory,
            basename,
            lock_name,
            lock,
        };
        guard.assert_guard()?;
        Ok(guard)
    }

    pub(in crate::operations::journal) fn current(&self, create: bool) -> Result<File> {
        let mut file = self.open(&self.basename, create, false)?;
        if !(create && file.metadata()?.len() == 0) {
            let mut magic = [0; MAGIC.len()];
            file.read_exact(&mut magic)?;
            if magic != MAGIC {
                return Err(OperationJournalError::Corrupt("invalid journal header"));
            }
            file.rewind()?;
        }
        Ok(file)
    }

    pub(super) fn sibling(&self, suffix: &[u8]) -> Result<CString> {
        sibling(&self.basename, suffix)
    }

    pub(super) fn open(&self, name: &CStr, create: bool, exclusive: bool) -> Result<File> {
        self.assert_guard()?;
        let file = open_file(&self.directory, name, create, exclusive)?;
        same_inode(&self.directory, name, &file)?;
        Ok(file)
    }

    pub(super) fn same_named(&self, name: &CStr, file: &File) -> Result<()> {
        self.assert_guard()?;
        same_inode(&self.directory, name, file)
    }

    fn assert_guard(&self) -> Result<()> {
        same_inode(&self.directory, &self.lock_name, &self.lock)
    }

    pub(super) fn entries(&self) -> Result<Vec<CString>> {
        self.entries_up_to(MAX_DIRECTORY_ENTRIES)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) fn entries_up_to(&self, maximum: usize) -> Result<Vec<CString>> {
        self.assert_guard()?;
        // A fresh description is essential: dup/try_clone shares directory
        // offset and could make the second inventory incorrectly appear empty.
        // SAFETY: directory is pinned and '.' is a static terminated basename.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: successful openat returned a new exclusively owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        // SAFETY: fd is an open directory. Ownership transfers only on success.
        let pointer = unsafe { libc::fdopendir(file.as_raw_fd()) };
        if pointer.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let _transferred = file.into_raw_fd();
        let stream = DirectoryStream(pointer);
        let mut names = Vec::new();
        loop {
            // SAFETY: libc returns this thread's live errno storage.
            #[cfg(target_os = "linux")]
            let errno = unsafe { libc::__errno_location() };
            // SAFETY: libc returns this thread's live errno storage.
            #[cfg(target_os = "macos")]
            let errno = unsafe { libc::__error() };
            // SAFETY: errno is thread-local; stream is owned and not shared.
            let entry = unsafe {
                *errno = 0;
                libc::readdir(stream.0)
            };
            if entry.is_null() {
                // SAFETY: no intervening libc call changed this thread's errno.
                let error = unsafe { *errno };
                if error != 0 {
                    return Err(std::io::Error::from_raw_os_error(error).into());
                }
                break;
            }
            // SAFETY: readdir returned a valid dirent until its next call, with
            // a NUL-terminated d_name. Copy it before advancing the stream.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name == c"." || name == c".." {
                continue;
            }
            if names.len() == maximum {
                return Err(OperationJournalError::CompactionDeferred(
                    "journal directory inventory exceeded its bound",
                ));
            }
            names.push(name.to_owned());
        }
        self.assert_guard()?;
        Ok(names)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn entries_up_to(&self, _maximum: usize) -> Result<Vec<CString>> {
        Err(OperationJournalError::CompactionDeferred(
            "bounded temp recovery unsupported on this platform",
        ))
    }
}

fn sibling(basename: &CStr, suffix: &[u8]) -> Result<CString> {
    let mut bytes = vec![b'.'];
    bytes.extend_from_slice(basename.to_bytes());
    bytes.extend_from_slice(suffix);
    CString::new(bytes).map_err(|_| OperationJournalError::Corrupt("invalid journal sibling name"))
}

fn validate_file(metadata: &Metadata) -> Result<()> {
    // SAFETY: geteuid only observes the current account identity.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(OperationJournalError::CompactionDeferred(
            "journal object is not private owner single-link regular data",
        ));
    }
    Ok(())
}

fn open_file(directory: &File, name: &CStr, create: bool, exclusive: bool) -> Result<File> {
    let flags = libc::O_RDWR
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if create { libc::O_CREAT } else { 0 }
        | if exclusive { libc::O_EXCL } else { 0 };
    // SAFETY: live directory fd and terminated basename; NONBLOCK prevents FIFO
    // opens hanging, NOFOLLOW prevents redirection; creation is private initially.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful openat returned a new exclusively owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    validate_file(&file.metadata()?)?;
    Ok(file)
}

fn same_inode(directory: &File, name: &CStr, file: &File) -> Result<()> {
    let metadata = file.metadata()?;
    validate_file(&metadata)?;
    let mut named = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: name is terminated, directory is open, named has stat-sized storage.
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            named.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: fstatat succeeded and initialized the complete stat value.
    let named = unsafe { named.assume_init() };
    // dev_t is signed on macOS and unsigned on Linux; preserve the u64 identity bits.
    let named_device = i128::from(named.st_dev) as u64;
    if named.st_ino != metadata.ino() || named_device != metadata.dev() {
        return Err(OperationJournalError::CompactionDeferred(
            "journal object identity changed",
        ));
    }
    Ok(())
}

struct DirectoryStream(*mut libc::DIR);
impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: this object exclusively owns a successful fdopendir result.
        // Closing releases resources; no journal authority depends on close errors.
        let _close = unsafe { libc::closedir(self.0) };
    }
}
