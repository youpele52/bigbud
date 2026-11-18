//! Narrow reuse of handle-verified private metadata for the local CLI pipe.
use super::{file, fs_handles::Directory, fs_read, fs_write, security, security_create};
use std::{io, path::Path};
use windows_sys::Win32::{Foundation::HANDLE, Security::EqualSid};

pub(crate) use super::control_lease::BackendLease;
pub(crate) use security_create::PrivateDescriptor;
pub(crate) fn pipe_descriptor() -> io::Result<PrivateDescriptor> {
    security_create::pipe_descriptor()
}
pub(crate) fn same_account(process: HANDLE) -> io::Result<bool> {
    let current = security::current_user()?;
    let peer = security::process_user(process)?;
    // SAFETY: both SIDs are owned validated TokenUser copies alive for this comparison.
    Ok(unsafe { EqualSid(current.pointer(), peer.pointer()) } != 0)
}
pub(crate) fn read_private(path: &str) -> io::Result<Vec<u8>> {
    file::read_private(path)
}

pub(crate) struct Publication {
    directory: Directory,
    name: String,
    id: String,
    hash: String,
}
impl Publication {
    pub(crate) fn create(filename: &str, content: &[u8], nonce: &str) -> io::Result<Self> {
        if content.len() > 1024
            || nonce.len() != 32
            || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(io::Error::other("endpoint bound"));
        }
        let path = Path::new(filename);
        let parent = path
            .parent()
            .and_then(Path::to_str)
            .ok_or_else(|| io::Error::other("endpoint parent"))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| io::Error::other("endpoint name"))?;
        let directory = match Directory::open(parent, "-", true) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let parent_path = Path::new(parent);
                let ancestor = parent_path
                    .parent()
                    .and_then(Path::to_str)
                    .ok_or_else(|| io::Error::other("control ancestor"))?;
                let leaf = parent_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| io::Error::other("control name"))?;
                let ancestor = Directory::open(ancestor, "-", false)?;
                fs_write::mkdir(&ancestor, leaf, &format!(".control-{nonce}"))?;
                Directory::open(parent, "-", true)?
            }
            Err(error) => return Err(error),
        };
        let previous = match fs_read::read(&directory, name, true, 1024) {
            Ok(previous) => Some(previous),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Some(previous) = &previous {
            let text = std::str::from_utf8(&previous.bytes).map_err(io::Error::other)?;
            let endpoint = crate::local_control::protocol::Endpoint::parse(text)?;
            if !crate::local_control::windows::prior_owner_dead(&endpoint)? {
                return Err(io::Error::other("endpoint owner still live or unknown"));
            }
        }
        let stage = format!(".endpoint-{nonce}");
        let (id, hash) = fs_write::create(
            &directory,
            &stage,
            &format!(".endpoint-write-{nonce}"),
            content,
        )?;
        let (id, hash) = fs_write::publish(
            &directory,
            &stage,
            &id,
            &hash,
            name,
            previous.as_ref().map_or("-", |p| p.id.as_str()),
            previous.as_ref().map_or("-", |p| p.hash.as_str()),
        )?;
        Ok(Self {
            directory,
            name: name.to_string(),
            id,
            hash,
        })
    }
    pub(crate) fn remove(&self) -> io::Result<()> {
        fs_write::remove(&self.directory, &self.name, &self.id, &self.hash)
    }
}

impl Drop for Publication {
    fn drop(&mut self) {
        // Best-effort only, always fenced by our exact identity and content. Never unlink a successor.
        let _cleanup = self.remove();
    }
}
