use std::ffi::{CStr, CString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use bigbud_protocol::v1;

use super::budget;
use super::identity::{identity_at, matches_identity, same_identity};
use crate::resource_cleanup::{MAX_DEPTH, MAX_ENTRIES, MAX_KNOWN_BYTES};

pub(super) struct Budget {
    deadline_unix_ms: u64,
    entries: usize,
    known_bytes: u64,
    mount_id: u64,
}

impl Budget {
    pub(super) fn new(deadline_unix_ms: u64, mount_id: u64) -> Self {
        Self {
            deadline_unix_ms,
            entries: 0,
            known_bytes: 0,
            mount_id,
        }
    }

    fn visit(&mut self, depth: usize) -> io::Result<()> {
        budget::check_deadline(self.deadline_unix_ms)?;
        self.entries += 1;
        if depth > MAX_DEPTH || self.entries > MAX_ENTRIES {
            return Err(io::Error::other("cleanup bound exceeded"));
        }
        Ok(())
    }

    fn add_known_bytes(&mut self, bytes: u64) -> io::Result<()> {
        self.known_bytes = self
            .known_bytes
            .checked_add(bytes)
            .ok_or_else(|| io::Error::other("known-byte bound exceeded"))?;
        if self.known_bytes > MAX_KNOWN_BYTES {
            return Err(io::Error::other("known-byte bound exceeded"));
        }
        Ok(())
    }
}

pub(super) fn validate_at(
    parent_fd: RawFd,
    name: &CStr,
    expected: &v1::ResourceCleanupIdentity,
    depth: usize,
    budget: &mut Budget,
) -> io::Result<()> {
    budget.visit(depth)?;
    if expected.entry_type == v1::ResourceCleanupEntryType::File as i32 {
        verify_file(parent_fd, name, expected, budget)?;
        return Ok(());
    }
    let directory = open_directory(parent_fd, name, expected, budget.mount_id)?;
    for entry in read_entries(
        directory.as_raw_fd(),
        MAX_ENTRIES.saturating_sub(budget.entries),
    )? {
        let identity = identity_at(directory.as_raw_fd(), &entry)?
            .ok_or_else(|| io::Error::other("entry disappeared"))?;
        if identity.device_or_volume != expected.device_or_volume {
            return Err(io::Error::other("mount boundary"));
        }
        validate_at(directory.as_raw_fd(), &entry, &identity, depth + 1, budget)?;
    }
    if !matches_identity(directory.as_raw_fd(), expected) {
        return Err(io::Error::other("identity changed"));
    }
    Ok(())
}

pub(super) fn remove_at(
    parent_fd: RawFd,
    name: &CStr,
    expected: &v1::ResourceCleanupIdentity,
    depth: usize,
    budget: &mut Budget,
) -> io::Result<()> {
    budget.visit(depth)?;
    if expected.entry_type == v1::ResourceCleanupEntryType::File as i32 {
        verify_file(parent_fd, name, expected, budget)?;
        // SAFETY: name is relative to the held verified parent descriptor.
        if unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(());
    }
    let directory = open_directory(parent_fd, name, expected, budget.mount_id)?;
    for entry in read_entries(
        directory.as_raw_fd(),
        MAX_ENTRIES.saturating_sub(budget.entries),
    )? {
        let identity = identity_at(directory.as_raw_fd(), &entry)?
            .ok_or_else(|| io::Error::other("entry disappeared"))?;
        if identity.device_or_volume != expected.device_or_volume {
            return Err(io::Error::other("mount boundary"));
        }
        remove_at(directory.as_raw_fd(), &entry, &identity, depth + 1, budget)?;
    }
    if !matches_identity(directory.as_raw_fd(), expected) {
        return Err(io::Error::other("identity changed"));
    }
    drop(directory);
    // SAFETY: verified directory name is removed relative to its held parent.
    if unsafe { libc::unlinkat(parent_fd, name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn verify_file(
    parent_fd: RawFd,
    name: &CStr,
    expected: &v1::ResourceCleanupIdentity,
    budget: &mut Budget,
) -> io::Result<()> {
    let actual = identity_at(parent_fd, name)?;
    if !actual
        .as_ref()
        .is_some_and(|identity| same_identity(identity, expected))
    {
        return Err(io::Error::other("identity changed"));
    }
    budget.add_known_bytes(budget::known_bytes_at(parent_fd, name)?)?;
    if !identity_at(parent_fd, name)?
        .as_ref()
        .is_some_and(|identity| same_identity(identity, expected))
    {
        return Err(io::Error::other("identity changed"));
    }
    Ok(())
}

fn open_directory(
    parent_fd: RawFd,
    name: &CStr,
    expected: &v1::ResourceCleanupIdentity,
    mount_id: u64,
) -> io::Result<OwnedFd> {
    // SAFETY: name is relative and O_NOFOLLOW prevents link traversal.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned an owned descriptor.
    let directory = unsafe { OwnedFd::from_raw_fd(fd) };
    if budget::mount_id(directory.as_raw_fd())? != mount_id {
        return Err(io::Error::other("mount boundary"));
    }
    if !matches_identity(directory.as_raw_fd(), expected) {
        return Err(io::Error::other("identity changed"));
    }
    Ok(directory)
}

fn read_entries(fd: RawFd, remaining: usize) -> io::Result<Vec<CString>> {
    // SAFETY: dup creates a descriptor consumed by fdopendir without affecting the caller's descriptor.
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: duplicate is a directory descriptor and ownership transfers to DIR.
    let directory = unsafe { libc::fdopendir(duplicate) };
    if directory.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut entries = Vec::new();
    loop {
        // SAFETY: directory remains valid until closed below.
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            break;
        }
        // SAFETY: d_name is NUL-terminated for the lifetime of the directory entry.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            if entries.len() == remaining {
                // SAFETY: fdopendir returned this DIR and close consumes it exactly once.
                unsafe { libc::closedir(directory) };
                return Err(io::Error::other("cleanup bound exceeded"));
            }
            entries.push(name.to_owned());
        }
    }
    // SAFETY: fdopendir returned this DIR and close consumes it exactly once.
    if unsafe { libc::closedir(directory) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(entries)
}
