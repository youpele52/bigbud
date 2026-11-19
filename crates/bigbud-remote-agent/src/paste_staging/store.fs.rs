use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::Upload;
use crate::paste_staging::PasteError;
use crate::state::{assert_secure_directory, create_private_directories, set_private_permissions};

pub(super) struct FileEntry {
    pub(super) path: PathBuf,
    pub(super) size: u64,
    pub(super) modified: SystemTime,
}

pub(super) fn is_partial(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "partial")
}

pub(super) fn ensure_private_directory(path: &Path) -> Result<(), PasteError> {
    let insecure = |error: crate::state::AgentStateError| PasteError::Insecure(error.to_string());
    if fs::symlink_metadata(path).is_err() {
        create_private_directories(path).map_err(insecure)?;
        set_private_permissions(path).map_err(insecure)?;
    }
    assert_secure_directory(path).map_err(insecure)
}

pub(super) fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub(super) fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Removing a partial file is best effort: the TTL sweep retries anything left behind.
pub(super) fn discard_upload(upload: Option<Upload>) {
    if let Some(mut upload) = upload {
        drop(upload.file.take());
        if remove_if_present(&upload.partial).is_err() {
            // Left for the TTL sweep; the upload identity is already gone.
        }
    }
}

pub(super) fn remove_scope_directory(directory: &Path) -> Result<u32, PasteError> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() {
        return Err(PasteError::Insecure("scope is not a directory".to_owned()));
    }
    let mut removed = 0u32;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            remove_if_present(&entry.path())?;
            removed += 1;
        }
    }
    match fs::remove_dir(directory) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(removed),
    }
}
