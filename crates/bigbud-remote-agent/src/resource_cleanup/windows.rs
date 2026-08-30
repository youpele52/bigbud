use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use bigbud_protocol::v1;
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, GetFileInformationByHandle, SYNCHRONIZE,
};

pub struct WindowsExecutor {
    roots: HashMap<String, Root>,
}

struct Root {
    _file: File,
    path: std::path::PathBuf,
    identity: v1::ResourceCleanupIdentity,
}

impl WindowsExecutor {
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
            let path = std::path::PathBuf::from(root.path);
            let file = open_verified(&path).map_err(|_| "ROOT_OPEN_FAILED".to_owned())?;
            let actual = identity(&file).map_err(|_| "ROOT_OPEN_FAILED".to_owned())?;
            if !same_identity(&actual, &expected) {
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
                    _file: file,
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
        check_deadline(deadline)?;
        let root = self
            .roots
            .get(&resource.root_handle)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown root"))?;
        let current_root = open_verified(&root.path);
        if !current_root
            .and_then(|file| identity(&file))
            .is_ok_and(|current| same_identity(&current, &root.identity))
            || !same_identity(&identity(&root._file)?, &root.identity)
            || !same_identity(&root.identity, required(&resource.root_identity)?)
        {
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let _lock = native::OperationLock::acquire(&root._file)?;
        if !same_identity(&identity(&root._file)?, &root.identity) {
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let (parent_file, target_name) = native::open_parent(&root._file, &resource.relative_path)?;
        if !same_identity(
            &identity(&parent_file)?,
            required(&resource.parent_identity)?,
        ) {
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let expected = match &resource.identity {
            Some(value) => value,
            None => return Ok(v1::ResourceCleanupOutcome::AlreadyAbsent),
        };
        let quarantine_name = std::ffi::OsStr::new(&resource.quarantine_name);
        let target = native::open_optional(&parent_file, &target_name)?;
        let quarantine = native::open_optional(&parent_file, quarantine_name)?;
        let (held, resumed) = match (target, quarantine) {
            (None, None) => return Ok(v1::ResourceCleanupOutcome::AlreadyAbsent),
            (Some(held), None) => {
                if !same_identity(&native::verified_identity(&held)?, expected) {
                    return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
                }
                (held, false)
            }
            (None, Some(held)) => {
                if !same_identity(&native::verified_identity(&held)?, expected) {
                    return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
                }
                (held, true)
            }
            _ => return Ok(v1::ResourceCleanupOutcome::IdentityMismatch),
        };
        let mut preflight_entries = 0;
        let mut preflight_bytes = 0;
        native::validate_tree(
            &held,
            expected,
            &root.identity.device_or_volume,
            &mut preflight_entries,
            &mut preflight_bytes,
            deadline,
        )?;
        if !resumed {
            if !same_identity(&native::verified_identity(&held)?, expected) {
                return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
            }
            native::rename(&held, &parent_file, quarantine_name)?;
        }
        if !same_identity(&native::verified_identity(&held)?, expected) {
            if !resumed {
                let _restore_result = native::rename(&held, &parent_file, &target_name);
            }
            return Ok(v1::ResourceCleanupOutcome::IdentityMismatch);
        }
        let mut entries = 0;
        let mut known_bytes = 0;
        native::remove_tree(
            held,
            expected,
            &root.identity.device_or_volume,
            0,
            &mut entries,
            &mut known_bytes,
            deadline,
        )?;
        Ok(if resumed {
            v1::ResourceCleanupOutcome::ResumedAndRemoved
        } else {
            v1::ResourceCleanupOutcome::Removed
        })
    }
}

pub(super) fn open_verified(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | SYNCHRONIZE)
        .share_mode(7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

pub(super) fn identity(file: &File) -> io::Result<v1::ResourceCleanupIdentity> {
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("unsupported reparse point"));
    }
    raw_identity(file, metadata.file_attributes())
}

pub(super) fn raw_identity(
    file: &File,
    attributes: u32,
) -> io::Result<v1::ResourceCleanupIdentity> {
    let kind = if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        v1::ResourceCleanupEntryType::Directory
    } else {
        v1::ResourceCleanupEntryType::File
    };
    // SAFETY: zeroed is a valid initial value and the live file handle grants metadata access.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the OS writes the fixed-size information structure for the live handle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let volume = information.dwVolumeSerialNumber;
    let file_id =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok(v1::ResourceCleanupIdentity {
        device_or_volume: volume.to_string(),
        inode_or_file_id: file_id.to_string(),
        entry_type: kind as i32,
    })
}

fn required(
    value: &Option<v1::ResourceCleanupIdentity>,
) -> io::Result<&v1::ResourceCleanupIdentity> {
    value
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing identity"))
}

fn same_identity(left: &v1::ResourceCleanupIdentity, right: &v1::ResourceCleanupIdentity) -> bool {
    left.device_or_volume == right.device_or_volume
        && left.inode_or_file_id == right.inode_or_file_id
        && left.entry_type == right.entry_type
}

pub(super) fn check_deadline(deadline: u64) -> io::Result<()> {
    if super::cancellation_requested() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "cleanup cancelled",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64;
    if now > deadline {
        Err(io::Error::new(io::ErrorKind::TimedOut, "deadline exceeded"))
    } else {
        Ok(())
    }
}

#[path = "windows.native.rs"]
mod native;

#[cfg(test)]
#[path = "windows.tests.rs"]
mod tests;
