use std::ffi::CStr;
use std::io;
use std::os::fd::RawFd;

use bigbud_protocol::v1;

pub(super) fn identity_at(
    parent: RawFd,
    name: &CStr,
) -> io::Result<Option<v1::ResourceCleanupIdentity>> {
    // SAFETY: zeroed is a valid initial state for libc::stat.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: name is NUL-terminated and parent is live; AT_SYMLINK_NOFOLLOW forbids traversal.
    let result =
        unsafe { libc::fstatat(parent, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        };
    }
    identity_from_stat(&stat).map(Some)
}

pub(super) fn matches_identity(fd: RawFd, expected: &v1::ResourceCleanupIdentity) -> bool {
    // SAFETY: zeroed is a valid initial state for libc::stat.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fd is held live by its owner for this call.
    (unsafe { libc::fstat(fd, &mut stat) == 0 })
        && identity_from_stat(&stat).is_ok_and(|actual| same_identity(&actual, expected))
}

fn identity_from_stat(stat: &libc::stat) -> io::Result<v1::ResourceCleanupIdentity> {
    let kind = match stat.st_mode & libc::S_IFMT {
        libc::S_IFREG | libc::S_IFLNK => v1::ResourceCleanupEntryType::File,
        libc::S_IFDIR => v1::ResourceCleanupEntryType::Directory,
        _ => return Err(io::Error::other("unsupported entry")),
    };
    Ok(v1::ResourceCleanupIdentity {
        device_or_volume: stat.st_dev.to_string(),
        inode_or_file_id: stat.st_ino.to_string(),
        entry_type: kind as i32,
    })
}

pub(super) fn same_identity(
    left: &v1::ResourceCleanupIdentity,
    right: &v1::ResourceCleanupIdentity,
) -> bool {
    left.device_or_volume == right.device_or_volume
        && left.inode_or_file_id == right.inode_or_file_id
        && left.entry_type == right.entry_type
}
