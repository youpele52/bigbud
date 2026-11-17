//! Receipt-bound original static tree custody; this is not publication approval.
pub(in crate::service_lease) mod json;
pub(in crate::service_lease) mod model;
mod tree;
use crate::service_lease::{Binding, Error, Result};
use model::Receipt;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
#[derive(Clone)]
pub struct Resource {
    pub(crate) state: PathBuf,
    pub(crate) generation: String,
    pub(crate) size: u64,
    pub(crate) sha256: [u8; 32],
    pub(crate) argument: String,
}
impl Resource {
    pub(crate) fn new(
        state: PathBuf,
        generation: String,
        size: u64,
        sha256: [u8; 32],
        argument: String,
    ) -> Result<Self> {
        if !state.is_absolute() {
            return Err(Error::Invalid);
        }
        Self::validate_reference(&generation, size, &sha256, &argument)?;
        Ok(Self {
            state,
            generation,
            size,
            sha256,
            argument,
        })
    }
    pub(crate) fn validate_reference(
        generation: &str,
        size: u64,
        sha256: &[u8],
        argument: &str,
    ) -> Result<()> {
        let suffix = generation.strip_prefix("assets-").ok_or(Error::Invalid)?;
        if suffix.len() != 32
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || sha256.len() != 32
            || size == 0
            || size > 8 * 1024 * 1024
            || !argument.starts_with("--")
            || argument.len() > 64
            || !argument.get(2..).is_some_and(|s| {
                !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
            })
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub(crate) fn root(&self) -> PathBuf {
        self.state
            .join("remote-mobile-runtime-v1")
            .join(&self.generation)
    }
    pub(crate) fn validate_argument(&self, args: &[String]) -> Result<()> {
        let root = self.root();
        let root = root.to_str().ok_or(Error::Invalid)?;
        let mut found = 0;
        for (index, arg) in args.iter().enumerate() {
            if arg == &self.argument {
                found += 1;
                if args.get(index + 1).map(String::as_str) != Some(root) {
                    return Err(Error::Refused);
                }
            } else if arg
                .strip_prefix(&self.argument)
                .is_some_and(|tail| tail.starts_with('='))
            {
                return Err(Error::Refused);
            }
        }
        if found != 1 {
            return Err(Error::Refused);
        }
        Ok(())
    }
    fn read(&self) -> Result<(Receipt, std::fs::File)> {
        let file = self
            .state
            .join("remote-mobile-runtime-v1")
            .join(format!("{}.receipt.json", self.generation));
        let mut held = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&file)?;
        let before = held.metadata()?;
        // SAFETY: geteuid only reads the executing account identity.
        if !before.is_file()
            || before.uid() != unsafe { libc::geteuid() }
            || before.mode() & 0o7777 != 0o600
            || before.nlink() != 1
            || before.size() != self.size
        {
            return Err(Error::Refused);
        }
        let mut bytes = Vec::new();
        held.by_ref().take(self.size + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != self.size
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != self.sha256
            || tree::stamp(&held.metadata()?)? != tree::stamp(&before)?
            || tree::stamp(&std::fs::symlink_metadata(&file)?)? != tree::stamp(&before)?
            || std::fs::canonicalize(file)?
                != self
                    .state
                    .join("remote-mobile-runtime-v1")
                    .join(format!("{}.receipt.json", self.generation))
        {
            return Err(Error::Refused);
        }
        let receipt = Receipt::parse(&bytes)?;
        if receipt.generation != self.generation {
            return Err(Error::Refused);
        }
        Ok((receipt, held))
    }
    pub(crate) fn validate(&self, binding: &Binding, args: &[String]) -> Result<()> {
        self.validate_argument(args)?;
        let (receipt, _held) = self.read()?;
        if receipt.authority != binding.authority
            || receipt.installation != binding.installation
            || receipt.nonce != binding.nonce
            || receipt.archive != binding.assets_sha256
        {
            return Err(Error::Refused);
        }
        tree::Tree::new(self.state.clone(), receipt)?;
        Ok(())
    }
    pub(crate) fn watch(&self) -> Result<Watch> {
        let (receipt, file) = self.read()?;
        let stamp = tree::stamp(&file.metadata()?)?;
        Ok(Watch {
            tree: tree::Tree::new(self.state.clone(), receipt)?,
            receipt: file,
            stamp,
            path: self
                .state
                .join("remote-mobile-runtime-v1")
                .join(format!("{}.receipt.json", self.generation)),
        })
    }
}
pub(crate) struct Watch {
    tree: tree::Tree,
    receipt: std::fs::File,
    stamp: model::Stamp,
    path: PathBuf,
}
impl Watch {
    pub(crate) fn check(&self) -> Result<()> {
        if tree::stamp(&self.receipt.metadata()?)? != self.stamp
            || tree::stamp(&std::fs::symlink_metadata(&self.path)?)? != self.stamp
            || std::fs::canonicalize(&self.path)? != self.path
        {
            return Err(Error::Refused);
        }
        self.tree.check()
    }
}
#[cfg(test)]
mod tests;
