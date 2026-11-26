//! Unix descriptor-relative inspection of a write target inside an opened parent directory.

use std::ffi::CStr;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};

use super::files::reader_sha256;
use super::{WorkspaceError, map_io};

/// The identity and ownership of an existing regular write target.
#[derive(Debug, Clone, Copy)]
pub(super) struct TargetStat {
    device: libc::dev_t,
    inode: libc::ino_t,
    links: libc::nlink_t,
    owner: libc::uid_t,
    group: libc::gid_t,
    /// Permission bits only (`0o7777`).
    pub(super) mode: libc::mode_t,
}

impl TargetStat {
    fn from_stat(metadata: &libc::stat) -> Self {
        Self {
            device: metadata.st_dev,
            inode: metadata.st_ino,
            links: metadata.st_nlink,
            owner: metadata.st_uid,
            group: metadata.st_gid,
            mode: metadata.st_mode & 0o7777,
        }
    }

    pub(super) fn same_identity(&self, other: &Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }

    /// A rename would split hard links or change the owner of these files, so they are
    /// rewritten in place instead (remote file editing plan, D3 and decision 4). A file the
    /// writer owns whose group alone differs stays atomic: the temporary file is `fchown`ed to
    /// the original group, and only if that is refused does the write fall back to in place.
    pub(super) fn requires_in_place(&self) -> bool {
        // SAFETY: geteuid takes no arguments, cannot fail, and touches no memory.
        let user = unsafe { libc::geteuid() };
        self.links > 1 || self.owner != user
    }

    pub(super) fn group(&self) -> libc::gid_t {
        self.group
    }
}

/// `fstat` of an open descriptor.
pub(super) fn fstat_file(file: &File) -> Result<libc::stat, WorkspaceError> {
    // SAFETY: libc::stat is a C data structure for which all-zero bytes are valid.
    let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
    // SAFETY: The file owns a valid descriptor and the stat buffer is writable.
    if unsafe { libc::fstat(file.as_raw_fd(), &mut metadata) } < 0 {
        return Err(map_io(std::io::Error::last_os_error()));
    }
    Ok(metadata)
}

fn check_file_type(metadata: &libc::stat) -> Result<(), WorkspaceError> {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFREG => Ok(()),
        libc::S_IFLNK => Err(WorkspaceError::SymlinkComponent),
        _ => Err(WorkspaceError::NotRegularFile),
    }
}

/// `fstatat` without following symlinks. `Ok(None)` when the target does not exist; symlinks
/// and non-regular files are refused before anything opens them.
pub(super) fn stat_target_at(
    parent: &File,
    name: &CStr,
) -> Result<Option<TargetStat>, WorkspaceError> {
    // SAFETY: libc::stat is a C data structure for which all-zero bytes are valid.
    let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
    // SAFETY: The directory descriptor, C string, and writable stat buffer remain valid.
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut metadata,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(map_io(error));
    }
    check_file_type(&metadata)?;
    Ok(Some(TargetStat::from_stat(&metadata)))
}

/// Opens the target with `access` (`O_RDONLY` or `O_RDWR`) plus `O_NOFOLLOW | O_NONBLOCK`, so a
/// symlink or FIFO swapped in after [`stat_target_at`] is neither followed nor blocks the agent.
/// `Ok(None)` when the target no longer exists.
pub(super) fn open_target_at(
    parent: &File,
    name: &CStr,
    access: libc::c_int,
) -> Result<Option<(File, TargetStat)>, WorkspaceError> {
    // SAFETY: The directory descriptor and C string remain valid; O_NOFOLLOW refuses symlinks.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            access | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Err(WorkspaceError::SymlinkComponent);
        }
        return Err(map_io(error));
    }
    // SAFETY: openat returned a valid descriptor whose ownership is transferred exactly once.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = fstat_file(&file)?;
    check_file_type(&metadata)?;
    Ok(Some((file, TargetStat::from_stat(&metadata))))
}

/// Hashes the current target through a fresh descriptor. `Ok(None)` when it does not exist.
pub(super) fn hash_target_at(
    parent: &File,
    name: &CStr,
) -> Result<Option<(String, TargetStat)>, WorkspaceError> {
    let Some((mut file, stat)) = open_target_at(parent, name, libc::O_RDONLY)? else {
        return Ok(None);
    };
    Ok(Some((reader_sha256(&mut file)?, stat)))
}

pub(super) fn write_conflict(expected: &str, actual: Option<String>) -> WorkspaceError {
    WorkspaceError::WriteConflict {
        expected: expected.to_owned(),
        actual,
    }
}

/// Re-reads `file` from the start and confirms it holds exactly `bytes`.
pub(super) fn verify_read_back(file: &mut File, bytes: &[u8]) -> Result<(), WorkspaceError> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(map_io)?;
    if reader_sha256(file)? != super::files::content_sha256(bytes) {
        return Err(WorkspaceError::WriteVerificationFailed);
    }
    Ok(())
}
