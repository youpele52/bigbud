use crate::native_fs::{
    acl::{self, Policy},
    descriptor::stat,
    invalid,
};
use std::{fs::File, io, os::fd::AsRawFd};

#[derive(PartialEq, Eq)]
pub(super) struct Snapshot {
    device: i32,
    inode: u64,
    mode: u16,
    uid: u32,
    gid: u32,
    links: u16,
    size: i64,
    modified: (i64, i64),
    changed: (i64, i64),
    flags: u32,
}
impl Snapshot {
    pub(super) fn read(file: &File, uid: u32, executable: bool) -> io::Result<Self> {
        let value = stat(file)?;
        // SAFETY: read-only flag query on the retained live descriptor.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if flags & libc::FD_CLOEXEC == 0
            || (value.st_uid != 0 && value.st_uid != uid)
            || value.st_mode & 0o7022 != 0
            || value.st_mode & libc::S_IFMT
                != if executable {
                    libc::S_IFREG
                } else {
                    libc::S_IFDIR
                }
            || (executable
                && (value.st_nlink != 1 || value.st_mode & 0o500 != 0o500 || value.st_size <= 0))
        {
            return Err(invalid());
        }
        acl::validate(file, Policy::Ancestor)?;
        Ok(Self {
            device: value.st_dev,
            inode: value.st_ino,
            mode: value.st_mode,
            uid: value.st_uid,
            gid: value.st_gid,
            links: value.st_nlink,
            size: value.st_size,
            modified: (value.st_mtime, value.st_mtime_nsec),
            changed: (value.st_ctime, value.st_ctime_nsec),
            flags: value.st_flags,
        })
    }
    pub(super) fn length(&self) -> io::Result<u64> {
        u64::try_from(self.size).map_err(|_| invalid())
    }
}
