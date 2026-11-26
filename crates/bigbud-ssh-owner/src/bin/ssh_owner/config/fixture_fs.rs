//! Descriptor-relative fixture access: never follow a symlink below the root.

use super::{ErrorCode, UNSUPPORTED};
use std::ffi::{CStr, CString};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::fd::IntoRawFd;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

const DIR_FLAGS: libc::c_int = libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

pub(super) struct Directory(File);

pub(super) enum DirectoryChild {
    Directory(Directory),
    RegularFile,
    Missing,
}

impl Directory {
    pub(super) fn root(path: &Path) -> Result<Self, ErrorCode> {
        OpenOptions::new()
            .read(true)
            .custom_flags(DIR_FLAGS)
            .open(path)
            .map(Self)
            .map_err(|_| UNSUPPORTED)
    }

    pub(super) fn metadata(&self) -> Result<Metadata, ErrorCode> {
        self.0.metadata().map_err(|_| UNSUPPORTED)
    }

    /// `openssh`: U17 production policy (owner or root, not group/world-writable),
    /// as OpenSSH checks; otherwise the fixture's owner-only, private directory.
    pub(super) fn child(
        &self,
        name: &CStr,
        uid: u32,
        openssh: bool,
    ) -> Result<DirectoryChild, ErrorCode> {
        // Inspect the entry itself first: a dangling symlink is not an empty glob.
        let Some(entry) = self.stat(name)? else {
            return Ok(DirectoryChild::Missing);
        };
        match entry.st_mode & libc::S_IFMT {
            libc::S_IFDIR => {}
            libc::S_IFREG => return Ok(DirectoryChild::RegularFile),
            _ => return Err(UNSUPPORTED),
        }
        let child = Self(self.open_at(name, DIR_FLAGS)?);
        let metadata = child.metadata()?;
        let permitted = if openssh {
            (metadata.uid() == uid || metadata.uid() == 0) && metadata.mode() & 0o022 == 0
        } else {
            metadata.uid() == uid && metadata.mode() & 0o577 == 0o500
        };
        if !metadata.is_dir() || !permitted || !same_entry(&entry, &metadata) {
            return Err(UNSUPPORTED);
        }
        Ok(DirectoryChild::Directory(child))
    }

    /// `allow_root`: a root-owned file is admitted too (U17 production config
    /// and trust files); private keys never set it.
    pub(super) fn regular(
        &self,
        name: &CStr,
        uid: u32,
        private: bool,
        allow_root: bool,
    ) -> Result<File, ErrorCode> {
        let entry = self.stat(name)?.ok_or(UNSUPPORTED)?;
        if entry.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(UNSUPPORTED);
        }
        let file = self.open_at(name, libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)?;
        let metadata = file.metadata().map_err(|_| UNSUPPORTED)?;
        check_regular(&metadata, uid, private, allow_root)?;
        if !same_entry(&entry, &metadata) {
            return Err(UNSUPPORTED);
        }
        Ok(file)
    }

    pub(super) fn contains(&self, name: &CStr) -> Result<bool, ErrorCode> {
        Ok(self.stat(name)?.is_some())
    }

    fn stat(&self, name: &CStr) -> Result<Option<libc::stat>, ErrorCode> {
        let mut entry = std::mem::MaybeUninit::uninit();
        // SAFETY: fd and name are live; fstatat writes a stat on success.
        let result = unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                entry.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            // SAFETY: successful fstatat initialized entry.
            Ok(Some(unsafe { entry.assume_init() }))
        } else if io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(UNSUPPORTED)
        }
    }

    fn open_at(&self, name: &CStr, flags: libc::c_int) -> Result<File, ErrorCode> {
        // SAFETY: fd and terminated name are live, and no create flag is used.
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | flags) };
        if fd < 0 {
            return Err(UNSUPPORTED);
        }
        // SAFETY: openat returned a fresh, owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn entries(&self) -> Result<Entries, ErrorCode> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            // Use a fresh open description so repeated globs each start at offset zero.
            let file = self.open_at(c".", DIR_FLAGS)?;
            // SAFETY: this is a live directory fd; ownership transfers only on success.
            let stream = unsafe { libc::fdopendir(file.as_raw_fd()) };
            if stream.is_null() {
                return Err(UNSUPPORTED);
            }
            let _transferred = file.into_raw_fd();
            Ok(Entries(stream))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        Err(UNSUPPORTED)
    }
}

// The stat field types vary by target; MetadataExt represents both as u64.
#[allow(clippy::unnecessary_cast)]
fn same_entry(entry: &libc::stat, metadata: &Metadata) -> bool {
    (entry.st_dev as u64, entry.st_ino as u64) == (metadata.dev(), metadata.ino())
}

fn check_regular(
    metadata: &Metadata,
    uid: u32,
    private: bool,
    allow_root: bool,
) -> Result<(), ErrorCode> {
    let mode_mask = if private { 0o077 } else { 0o022 };
    if !metadata.is_file()
        || !(metadata.uid() == uid || (allow_root && metadata.uid() == 0))
        || metadata.nlink() != 1
        || metadata.mode() & mode_mask != 0
        || (private && metadata.mode() & 0o400 == 0)
    {
        return Err(UNSUPPORTED);
    }
    Ok(())
}

pub(super) struct Entries(*mut libc::DIR);

impl Entries {
    pub(super) fn next(&mut self) -> Result<Option<CString>, ErrorCode> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            // SAFETY: libc returns the current thread's errno pointer.
            #[cfg(target_os = "macos")]
            let errno = unsafe { libc::__error() };
            // SAFETY: libc returns the current thread's errno pointer.
            #[cfg(target_os = "linux")]
            let errno = unsafe { libc::__errno_location() };
            loop {
                // SAFETY: this stream is live and exclusively owned, and errno is thread-local.
                let entry = unsafe {
                    *errno = 0;
                    libc::readdir(self.0)
                };
                if entry.is_null() {
                    // SAFETY: no intervening libc call has changed this thread's errno.
                    return if unsafe { *errno } == 0 {
                        Ok(None)
                    } else {
                        Err(UNSUPPORTED)
                    };
                }
                // SAFETY: readdir returned a valid, terminated name until the next call.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                if name != c"." && name != c".." {
                    return Ok(Some(name.to_owned()));
                }
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        Err(UNSUPPORTED)
    }
}

impl Drop for Entries {
    fn drop(&mut self) {
        // SAFETY: fdopendir returned this stream; closedir consumes it exactly once.
        let _closed = unsafe { libc::closedir(self.0) };
    }
}
