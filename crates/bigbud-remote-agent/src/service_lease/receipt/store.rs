//! Private durable receipt files: atomic replace, owner-only, bounded size and count.
use super::model::{MAX_BYTES, Receipt};
use crate::service_lease::{Error, Result};
use sha2::{Digest, Sha256};
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Retained receipts, including uncertain ones preserved for repair.
pub(in crate::service_lease) const CAPACITY: usize = 16;
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

fn euid() -> u32 {
    // SAFETY: geteuid only reads the executing account identity.
    unsafe { libc::geteuid() }
}

pub(in crate::service_lease) struct Store {
    root: PathBuf,
}
impl Store {
    /// No filesystem IO until the first readiness launch needs durable evidence.
    pub(in crate::service_lease) fn new(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() || root.parent().is_none() {
            return Err(Error::Invalid);
        }
        Ok(Self { root })
    }
    fn verify_root(&self) -> Result<()> {
        let info = std::fs::symlink_metadata(&self.root)?;
        if !info.is_dir() || info.uid() != euid() || info.mode() & 0o7777 != 0o700 {
            return Err(Error::Refused);
        }
        Ok(())
    }
    fn path(&self, nonce: &str) -> PathBuf {
        let digest = crate::local_control::protocol::hex(&Sha256::digest(nonce.as_bytes()));
        self.root.join(format!("{digest}.json"))
    }
    fn sync_root(&self) -> Result<()> {
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    /// Create the private namespace, discard orphaned temporaries, prune receipts whose
    /// original child is proven dead, then refuse a new launch when retention is full.
    pub(in crate::service_lease) fn prepare(
        &self,
        dead: impl Fn(&Receipt) -> Result<bool>,
    ) -> Result<()> {
        match DirBuilder::new().mode(0o700).create(&self.root) {
            Ok(()) => self.sync_parent()?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        self.verify_root()?;
        let mut retained = 0usize;
        for entry in std::fs::read_dir(&self.root)?.take(CAPACITY * 4 + 1) {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::Uncertain)?;
            let info = std::fs::symlink_metadata(entry.path())?;
            if name.starts_with('.') && name.ends_with(".tmp") && info.is_file() {
                // Never-renamed bytes were never evidence; remove only our own regular file.
                if info.uid() == euid() {
                    std::fs::remove_file(entry.path())?;
                    continue;
                }
            }
            let receipt = match self.read_path(&entry.path()) {
                Ok(receipt) => receipt,
                // Unreadable or foreign bytes are preserved and still count against capacity.
                Err(_) => {
                    retained += 1;
                    continue;
                }
            };
            if self.path(&receipt.binding.nonce) == entry.path() && dead(&receipt)? {
                self.remove(&receipt)?;
            } else {
                retained += 1;
            }
        }
        if retained >= CAPACITY {
            return Err(Error::Occupied);
        }
        Ok(())
    }
    fn sync_parent(&self) -> Result<()> {
        let parent = self.root.parent().ok_or(Error::Invalid)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    }

    /// Atomic replace through a private exclusive temporary, then read-back verification.
    pub(in crate::service_lease) fn write(&self, receipt: &Receipt) -> Result<()> {
        self.verify_root()?;
        let bytes = receipt.encode()?;
        let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let temporary = self
            .root
            .join(format!(".{}-{sequence}.tmp", std::process::id()));
        let written = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temporary, self.path(&receipt.binding.nonce))?;
            self.sync_root()
        })();
        if written.is_err() {
            // The temporary is never evidence; an orphan is also removed by `prepare`.
            let _orphan = std::fs::remove_file(&temporary);
        }
        written?;
        if self.read(&receipt.binding.nonce)?.as_ref() != Some(receipt) {
            return Err(Error::Uncertain);
        }
        Ok(())
    }

    pub(in crate::service_lease) fn read(&self, nonce: &str) -> Result<Option<Receipt>> {
        self.verify_root()?;
        match self.read_path(&self.path(nonce)) {
            Ok(receipt) if receipt.binding.nonce == nonce => Ok(Some(receipt)),
            Ok(_) => Err(Error::Refused),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn read_path(&self, path: &Path) -> Result<Receipt> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)?;
        let info = file.metadata()?;
        if !info.is_file()
            || info.uid() != euid()
            || info.mode() & 0o7777 != 0o600
            || info.nlink() != 1
            || info.len() > MAX_BYTES as u64
        {
            return Err(Error::Refused);
        }
        let mut bytes = Vec::with_capacity(info.len() as usize);
        Read::by_ref(&mut file)
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != info.len() {
            return Err(Error::Uncertain);
        }
        Receipt::parse(&bytes)
    }

    /// Remove only the exact receipt this owner expects; a changed file is preserved.
    pub(in crate::service_lease) fn remove(&self, expected: &Receipt) -> Result<()> {
        let path = self.path(&expected.binding.nonce);
        match self.read_path(&path) {
            Ok(current) if current == *expected => (),
            Ok(_) => return Err(Error::Uncertain),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
        std::fs::remove_file(path)?;
        self.sync_root()
    }
}
