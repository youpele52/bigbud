//! A pinned, exclusive lease prevents a delayed helper publishing for a replaced backend.
use super::{
    fs_handles::{self, Directory},
    fs_read,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_READ_DATA, FILE_SHARE_READ, FILE_WRITE_DATA};

pub(crate) struct BackendLease {
    _parent: Directory,
    _file: File,
}
impl BackendLease {
    pub(crate) fn open(filename: &str, expected_hash: &str) -> io::Result<Self> {
        if expected_hash.len() != 64 || !expected_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(io::Error::other("backend fingerprint rejected"));
        }
        let path = Path::new(filename);
        let parent = path
            .parent()
            .and_then(Path::to_str)
            .ok_or_else(|| io::Error::other("backend parent rejected"))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| *n == "backend.lock")
            .ok_or_else(|| io::Error::other("backend filename rejected"))?;
        let parent = Directory::open(parent, "-", true)?;
        // Deny deletion and data writers for the entire helper lifetime. The backend replaces
        // this file through exclusive creation/rename, never an in-place update.
        let mut file = fs_handles::child(
            &parent,
            name,
            false,
            false,
            FILE_READ_DATA | FILE_WRITE_DATA,
            FILE_SHARE_READ,
        )?;
        fs_read::validate(&file, true)?;
        // Requested write access plus deny-write sharing admits exactly one helper.
        // No byte-range lock: ordinary read-only clients can still inspect this file.
        if file.metadata()?.len() > 8192 {
            return Err(io::Error::other("backend byte bound"));
        }
        let mut bytes = Vec::new();
        file.by_ref().take(8193).read_to_end(&mut bytes)?;
        if bytes.len() > 8192 || format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
            return Err(io::Error::other("backend generation changed"));
        }
        parent.revalidate()?;
        Ok(Self {
            _parent: parent,
            _file: file,
        })
    }
}
