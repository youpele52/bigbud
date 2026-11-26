//! U17 production scope policy: OpenSSH's own safety checks instead of the
//! fixture's private scope. A user config at `<home>/.ssh/config` is rooted at
//! the real home, so `~/` is the home and Includes such as
//! `~/.orbstack/ssh/config` are in scope; anything outside the root, any
//! symlink below it and any path another account could modify stay refused.

use super::{ErrorCode, literal_parent};
use std::fs::{self, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// What a scoped file is, which decides its permission rule.
#[derive(Clone, Copy)]
pub(in super::super) enum Kind {
    /// A config or Include. The fixture keeps its own `private` rule.
    Config { private: bool },
    /// A known-hosts file.
    Trust,
    /// A private key: owned by the account and readable by no one else, as
    /// OpenSSH requires, under either policy.
    Key,
}

impl Kind {
    /// `(private, allow_root)` for `Directory::regular`.
    pub(super) fn rule(self, openssh: bool) -> (bool, bool) {
        match (self, openssh) {
            (Kind::Key, _) => (true, false),
            (Kind::Config { private }, false) => (private, false),
            (Kind::Trust, false) => (true, false),
            // OpenSSH: owned by the account or root, writable by neither group nor others.
            (Kind::Config { .. } | Kind::Trust, true) => (false, true),
        }
    }
}

/// `(root, base, home_rooted)`: `<home>/.ssh/config` is rooted at `<home>`
/// with base `.ssh`; any other config at its own directory.
pub(super) fn production_root(path: &Path) -> Result<(PathBuf, PathBuf, bool), ErrorCode> {
    let parent = literal_parent(path, false)?;
    match (parent.file_name(), parent.parent()) {
        (Some(name), Some(home)) if name == ".ssh" && home.is_absolute() => {
            Ok((home.to_owned(), PathBuf::from(".ssh"), true))
        }
        _ => Ok((parent.to_owned(), PathBuf::new(), false)),
    }
}

/// A scope directory: owned by the account or root, not group/world-writable.
pub(super) fn trusted_directory(metadata: &Metadata, uid: u32) -> bool {
    (metadata.uid() == uid || metadata.uid() == 0) && metadata.mode() & 0o022 == 0
}

/// Every ancestor of the canonical root up to `/` passes the same rule, or is
/// a root-owned sticky directory (another account cannot rename its entries).
pub(super) fn trusted_ancestors(canonical: &Path, uid: u32) -> bool {
    canonical.ancestors().skip(1).all(|ancestor| {
        fs::symlink_metadata(ancestor).is_ok_and(|metadata| {
            metadata.is_dir()
                && (trusted_directory(&metadata, uid)
                    || (metadata.uid() == 0 && metadata.mode() & 0o1000 != 0))
        })
    }) || canonical.parent().is_none()
}

impl super::Scope {
    /// A key that exists under the root and passes the private-key rule (U17
    /// default identities); any failure means "not usable", never an error.
    pub(in super::super) fn usable_key(&self, absolute: &Path) -> bool {
        absolute
            .strip_prefix(&self.canonical)
            .is_ok_and(|relative| self.identity_stamp(relative).is_ok())
    }
}
