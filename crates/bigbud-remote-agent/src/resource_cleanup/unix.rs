use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use bigbud_protocol::v1;

pub struct UnixExecutor {
    roots: HashMap<String, Root>,
}

struct Root {
    file: File,
    path: CString,
    identity: v1::ResourceCleanupIdentity,
}

impl UnixExecutor {
    pub fn new() -> Self {
        Self {
            roots: HashMap::new(),
        }
    }

    pub fn bootstrap(
        &mut self,
        roots: Vec<v1::ResourceCleanupRoot>,
    ) -> Result<Vec<v1::ResourceCleanupRootHandle>, String> {
        let mut opened = HashMap::new();
        let mut handles = Vec::new();
        for root in roots {
            let expected = root.identity.ok_or_else(|| "INVALID_ROOT".to_owned())?;
            let path = CString::new(root.path.as_bytes()).map_err(|_| "INVALID_ROOT".to_owned())?;
            // SAFETY: path is a valid NUL-terminated string and flags require a real directory.
            let fd = unsafe {
                libc::open(
                    path.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err("ROOT_OPEN_FAILED".to_owned());
            }
            // SAFETY: open returned an owned file descriptor.
            let file = unsafe { File::from_raw_fd(fd) };
            if !matches_identity(file.as_raw_fd(), &expected) {
                return Err("ROOT_IDENTITY_MISMATCH".to_owned());
            }
            let handle = format!("root-{}", handles.len());
            handles.push(v1::ResourceCleanupRootHandle {
                root_id: root.root_id,
                root_handle: handle.clone(),
            });
            opened.insert(
                handle,
                Root {
                    file,
                    path,
                    identity: expected,
                },
            );
        }
        self.roots = opened;
        Ok(handles)
    }

    pub fn execute(
        &mut self,
        request: v1::ResourceCleanupRequest,
    ) -> Vec<v1::ResourceCleanupResult> {
        request
            .resources
            .into_iter()
            .map(|resource| {
                let result = self.execute_one(&resource, request.deadline_unix_ms);
                let error_code = result
                    .as_ref()
                    .err()
                    .filter(|error| error.kind() == io::ErrorKind::Interrupted)
                    .map_or_else(String::new, |_| "CANCELLED".to_owned());
                let outcome = result.unwrap_or_else(|error| super::errors::outcome(&error));
                v1::ResourceCleanupResult {
                    resource_id: resource.resource_id,
                    outcome: outcome as i32,
                    error_code,
                }
            })
            .collect()
    }

    pub fn validate_handles(&self, request: &v1::ResourceCleanupRequest) -> Result<(), String> {
        request
            .resources
            .iter()
            .all(|resource| self.roots.contains_key(&resource.root_handle))
            .then_some(())
            .ok_or_else(|| "UNKNOWN_ROOT_HANDLE".to_owned())
    }

    fn execute_one(
        &self,
        resource: &v1::ResourceCleanupResource,
        deadline: u64,
    ) -> io::Result<v1::ResourceCleanupOutcome> {
        let root = self
            .roots
            .get(&resource.root_handle)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown root"))?;
        if !root::path_matches(&root.path, &root.identity)
            || !matches_identity(root.file.as_raw_fd(), &root.identity)
            || !matches_identity(root.file.as_raw_fd(), required(&resource.root_identity)?)
        {
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        // SAFETY: flock acts on the held root descriptor and is released when this call returns.
        if unsafe { libc::flock(root.file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Ok(v1::ResourceCleanupOutcome::Busy);
        }
        let result = self.execute_locked(root.file.as_raw_fd(), resource, deadline);
        // SAFETY: the same live descriptor owns the advisory lock.
        let _unlock_result = unsafe { libc::flock(root.file.as_raw_fd(), libc::LOCK_UN) };
        result
    }

    fn execute_locked(
        &self,
        root_fd: RawFd,
        resource: &v1::ResourceCleanupResource,
        deadline: u64,
    ) -> io::Result<v1::ResourceCleanupOutcome> {
        budget::check_deadline(deadline)?;
        let root_mount_id = budget::mount_id(root_fd)?;
        let (parent, name) = open_parent(root_fd, &resource.relative_path, root_mount_id)?;
        if !matches_identity(parent.as_raw_fd(), required(&resource.parent_identity)?) {
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let quarantine = path::cstring(OsStr::new(&resource.quarantine_name))?;
        let original = path::cstring(name)?;
        let expected = match &resource.identity {
            Some(identity) => identity,
            None => return Ok(v1::ResourceCleanupOutcome::AlreadyAbsent),
        };
        let original_identity = identity_at(parent.as_raw_fd(), &original)?;
        let quarantine_identity = identity_at(parent.as_raw_fd(), &quarantine)?;
        let mut preflight = tree::Budget::new(deadline, root_mount_id);
        let resumed = match (original_identity, quarantine_identity) {
            (None, None) => return Ok(v1::ResourceCleanupOutcome::AlreadyAbsent),
            (Some(found), None) if same_identity(&found, expected) => {
                tree::validate_at(parent.as_raw_fd(), &original, expected, 0, &mut preflight)?;
                if !identity_at(parent.as_raw_fd(), &original)?
                    .as_ref()
                    .is_some_and(|identity| same_identity(identity, expected))
                {
                    return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
                }
                // SAFETY: both names are validated single components in the held parent descriptor.
                let renamed = unsafe {
                    libc::renameat(
                        parent.as_raw_fd(),
                        original.as_ptr(),
                        parent.as_raw_fd(),
                        quarantine.as_ptr(),
                    )
                };
                if renamed != 0 {
                    return Err(io::Error::last_os_error());
                }
                false
            }
            (None, Some(found)) if same_identity(&found, expected) => {
                tree::validate_at(parent.as_raw_fd(), &quarantine, expected, 0, &mut preflight)?;
                true
            }
            _ => return Ok(v1::ResourceCleanupOutcome::IdentityMismatch),
        };
        let after = identity_at(parent.as_raw_fd(), &quarantine)?;
        if !after
            .as_ref()
            .is_some_and(|identity| same_identity(identity, expected))
        {
            if !resumed {
                // SAFETY: validated names and held parent descriptor; restoration is best effort.
                let _restore_result = unsafe {
                    libc::renameat(
                        parent.as_raw_fd(),
                        quarantine.as_ptr(),
                        parent.as_raw_fd(),
                        original.as_ptr(),
                    )
                };
            }
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let mut removal = tree::Budget::new(deadline, root_mount_id);
        tree::remove_at(parent.as_raw_fd(), &quarantine, expected, 0, &mut removal)?;
        Ok(if resumed {
            v1::ResourceCleanupOutcome::ResumedAndRemoved
        } else {
            v1::ResourceCleanupOutcome::Removed
        })
    }
}

fn required(
    value: &Option<v1::ResourceCleanupIdentity>,
) -> io::Result<&v1::ResourceCleanupIdentity> {
    value
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing identity"))
}

fn open_parent(
    root_fd: RawFd,
    relative: &str,
    root_mount_id: u64,
) -> io::Result<(OwnedFd, &OsStr)> {
    let path = std::path::Path::new(relative);
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing name"))?;
    // SAFETY: dup creates an independently owned descriptor from the live root descriptor.
    let duplicate = unsafe { libc::dup(root_fd) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: dup returned an owned descriptor.
    let mut parent = unsafe { OwnedFd::from_raw_fd(duplicate) };
    if let Some(ancestors) = path.parent() {
        for component in ancestors.components() {
            let segment = path::cstring(component.as_os_str())?;
            // SAFETY: segment is a single validated component and parent remains live.
            let next = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    segment.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if next < 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ENOTDIR) {
                    Err(io::Error::other("unsupported entry"))
                } else {
                    Err(error)
                };
            }
            // SAFETY: openat returned an owned descriptor.
            parent = unsafe { OwnedFd::from_raw_fd(next) };
            if budget::mount_id(parent.as_raw_fd())? != root_mount_id {
                return Err(io::Error::other("mount boundary"));
            }
        }
    }
    Ok((parent, name))
}

#[path = "unix.budget.rs"]
mod budget;

#[path = "unix.identity.rs"]
mod identity;

use identity::{identity_at, matches_identity, same_identity};

#[path = "unix.path.rs"]
mod path;

#[path = "unix.root.rs"]
mod root;

#[path = "unix.tree.rs"]
mod tree;

#[cfg(test)]
#[path = "unix.tests.rs"]
mod tests;
