//! Original tree custody. Full content hashing on admission, metadata-only invalidation later.
use super::model::{Anchor, Receipt, Stamp, path_digest};
use crate::service_lease::{Error, Result};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
fn time(seconds: i64, nanos: i64) -> Result<u64> {
    let value = i128::from(seconds) * 1_000_000_000 + i128::from(nanos);
    u64::try_from(value).map_err(|_| Error::Invalid)
}
pub(super) fn anchor(m: &Metadata) -> Anchor {
    Anchor {
        dev: m.dev(),
        ino: m.ino(),
        uid: m.uid().into(),
        gid: m.gid().into(),
        mode: m.mode().into(),
    }
}
pub(super) fn stamp(m: &Metadata) -> Result<Stamp> {
    Ok(Stamp {
        anchor: anchor(m),
        nlink: m.nlink(),
        size: m.size(),
        mtime: time(m.mtime(), m.mtime_nsec())?,
        ctime: time(m.ctime(), m.ctime_nsec())?,
    })
}
pub(super) fn directory(path: &Path, expected: &Anchor) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)?;
    let actual = file.metadata()?;
    if !actual.is_dir()
        || anchor(&actual) != *expected
        || anchor(&std::fs::symlink_metadata(path)?) != *expected
        || std::fs::canonicalize(path)? != path
    {
        return Err(Error::Refused);
    }
    Ok(file)
}
struct Walk<'a> {
    receipt: &'a Receipt,
    seen: BTreeSet<[u8; 32]>,
    paths: Vec<(PathBuf, [u8; 32])>,
    hash: bool,
    scratch: [u8; 65536],
}
impl Walk<'_> {
    fn entry(&mut self, path: &Path, relative: &str, depth: usize) -> Result<()> {
        if depth > 32 || relative.len() > 4096 || self.seen.len() >= 16385 {
            return Err(Error::Invalid);
        }
        let before = std::fs::symlink_metadata(path)?;
        let directory = before.is_dir();
        if !directory && !before.is_file() {
            return Err(Error::Refused);
        }
        let digest = path_digest(directory, relative);
        let expected = self
            .receipt
            .entries
            .get(&digest)
            .ok_or(Error::Refused)?
            .clone();
        if expected.directory != directory
            || stamp(&before)? != expected.stamp
            || !self.seen.insert(digest)
        {
            return Err(Error::Refused);
        }
        self.paths.push((path.to_path_buf(), digest));
        if directory {
            let held = directory_handle(path)?;
            if stamp(&held.metadata()?)? != expected.stamp {
                return Err(Error::Refused);
            }
            for item in std::fs::read_dir(path)? {
                let item = item?;
                let name = item.file_name().into_string().map_err(|_| Error::Invalid)?;
                if name.is_empty()
                    || name == "."
                    || name == ".."
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                {
                    return Err(Error::Refused);
                }
                let next = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                self.entry(&item.path(), &next, depth + 1)?;
            }
            if stamp(&held.metadata()?)? != expected.stamp {
                return Err(Error::Refused);
            }
        } else if self.hash {
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)?;
            if !file.metadata()?.is_file() || stamp(&file.metadata()?)? != expected.stamp {
                return Err(Error::Refused);
            }
            let mut hash = Sha256::new();
            let mut total = 0u64;
            loop {
                let count = file.read(&mut self.scratch)?;
                if count == 0 {
                    break;
                }
                total = total.checked_add(count as u64).ok_or(Error::Invalid)?;
                if total > expected.stamp.size {
                    return Err(Error::Refused);
                }
                hash.update(self.scratch.get(..count).ok_or(Error::Invalid)?);
            }
            let actual: [u8; 32] = hash.finalize().into();
            if total != expected.stamp.size
                || Some(actual) != expected.sha256
                || stamp(&file.metadata()?)? != expected.stamp
            {
                return Err(Error::Refused);
            }
        }
        if stamp(&std::fs::symlink_metadata(path)?)? != expected.stamp
            || std::fs::canonicalize(path)? != path
        {
            return Err(Error::Refused);
        }
        Ok(())
    }
}
fn directory_handle(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)?)
}
pub(super) struct Tree {
    state: PathBuf,
    namespace: PathBuf,
    root: PathBuf,
    held: [File; 3],
    receipt: Receipt,
    paths: Vec<(PathBuf, [u8; 32])>,
}
impl Tree {
    pub(super) fn new(state: PathBuf, receipt: Receipt) -> Result<Self> {
        let namespace = state.join("remote-mobile-runtime-v1");
        let root = namespace.join(&receipt.generation);
        let held = [
            directory(&state, &receipt.state)?,
            directory(&namespace, &receipt.namespace)?,
            directory(&root, &receipt.root)?,
        ];
        let mut tree = Self {
            state,
            namespace,
            root,
            held,
            receipt,
            paths: Vec::new(),
        };
        tree.anchors()?;
        let mut walk = Walk {
            receipt: &tree.receipt,
            seen: BTreeSet::new(),
            paths: Vec::new(),
            hash: true,
            scratch: [0; 65536],
        };
        walk.entry(&tree.root, "", 0)?;
        if walk.seen.len() != tree.receipt.entries.len() {
            return Err(Error::Refused);
        }
        tree.paths = walk.paths;
        tree.check()?;
        Ok(tree)
    }
    fn anchors(&self) -> Result<()> {
        for ((path, expected), held) in [
            (&self.state, &self.receipt.state),
            (&self.namespace, &self.receipt.namespace),
            (&self.root, &self.receipt.root),
        ]
        .into_iter()
        .zip(&self.held)
        {
            if anchor(&std::fs::symlink_metadata(path)?) != *expected
                || anchor(&held.metadata()?) != *expected
                || std::fs::canonicalize(path)? != *path
            {
                return Err(Error::Refused);
            }
        }
        Ok(())
    }
    pub(super) fn check(&self) -> Result<()> {
        self.anchors()?;
        // The original complete membership is cached, not rediscovered/adopted.
        // Every directory's immutable ctime/mtime catches added/removed members,
        // including an add followed by deletion or restored mtime. Atime is ignored.
        for (path, digest) in &self.paths {
            let expected = self.receipt.entries.get(digest).ok_or(Error::Refused)?;
            if stamp(&std::fs::symlink_metadata(path)?)? != expected.stamp {
                return Err(Error::Refused);
            }
        }
        self.anchors()
    }
}
