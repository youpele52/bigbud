use super::{
    file,
    fs_handles::{self, Directory},
    fs_read,
    protocol::unhex,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    os::windows::fs::MetadataExt,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_READ_DATA, FILE_SHARE_READ};

pub(super) struct Lease {
    parent: Directory,
    file: File,
    token: String,
    id: String,
    hash: String,
    size: u64,
    modified: u64,
}
fn text(value: &str) -> io::Result<String> {
    String::from_utf8(unhex(value)?).map_err(io::Error::other)
}

impl Lease {
    fn open(parent: &str, name: &str, token: &str) -> io::Result<Self> {
        if token.len() != 32 || !token.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err(io::Error::other("lease token rejected"));
        }
        let parent = Directory::open(parent, "-", true)?;
        let mut file =
            fs_handles::child(&parent, name, false, false, FILE_READ_DATA, FILE_SHARE_READ)?;
        fs_read::validate(&file, true)?;
        let id = file::identity(&file)?;
        let metadata = file.metadata()?;
        let size = metadata.len();
        let modified = metadata.last_write_time();
        if size > 536_870_912 {
            return Err(io::Error::other("lease byte bound"));
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut total = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > size {
                return Err(io::Error::other("lease file changed"));
            }
            hash.update(
                buffer
                    .get(..count)
                    .ok_or_else(|| io::Error::other("read bound"))?,
            );
        }
        if total != size {
            return Err(io::Error::other("lease file changed"));
        }
        let lease = Self {
            parent,
            file,
            token: token.into(),
            id,
            hash: format!("{:x}", hash.finalize()),
            size,
            modified,
        };
        lease.check()?;
        Ok(lease)
    }
    fn check(&self) -> io::Result<()> {
        self.parent.revalidate()?;
        fs_read::validate(&self.file, true)?;
        let metadata = self.file.metadata()?;
        if file::identity(&self.file)? != self.id
            || metadata.len() != self.size
            || metadata.last_write_time() != self.modified
        {
            return Err(io::Error::other("lease file changed"));
        }
        Ok(())
    }
}

/// One read lease per helper; EOF drops it. No writes or process control are implied by the lease.
pub(super) fn dispatch(line: &str, lease: &mut Option<Lease>) -> io::Result<String> {
    let parts: Vec<_> = line.split('\t').collect();
    match parts.as_slice() {
        ["FS", "1", "LEASE_OPEN", parent, name, token] if lease.is_none() => {
            let opened = Lease::open(&text(parent)?, &text(name)?, token)?;
            let response = format!("OK\t{}\t{}\t{}", opened.id, opened.hash, opened.size);
            *lease = Some(opened);
            Ok(response)
        }
        ["FS", "1", "LEASE_CHECK", token] => {
            let value = lease
                .as_ref()
                .filter(|value| value.token == *token)
                .ok_or_else(|| io::Error::other("lease unavailable"))?;
            value.check()?;
            Ok("OK".into())
        }
        ["FS", "1", "LEASE_CLOSE", token] => {
            if lease.as_ref().is_none_or(|value| value.token != *token) {
                return Err(io::Error::other("lease unavailable"));
            }
            *lease = None;
            Ok("OK".into())
        }
        _ => Err(io::Error::other("lease request rejected")),
    }
}
