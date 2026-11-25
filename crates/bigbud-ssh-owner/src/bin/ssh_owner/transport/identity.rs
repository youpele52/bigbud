//! Metadata-only admission for explicitly configured Unix proof identities.

use super::ErrorCode;
use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;

const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;
const MAX_IDENTITY_BYTES: u64 = 64 * 1024;

pub(super) struct IdentityFiles(Vec<IdentityFile>);

struct IdentityFile {
    path: PathBuf,
    stamp: Stamp,
    public: Option<Stamp>,
}

impl IdentityFiles {
    pub(super) fn bind<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Result<Self, ErrorCode> {
        paths
            .into_iter()
            .map(IdentityFile::bind)
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }

    pub(super) fn apply_to(&self, ssh: &mut Command) -> Result<(), ErrorCode> {
        for identity in &self.0 {
            identity.revalidate()?;
            ssh.arg("-i").arg(&identity.path);
        }
        Ok(())
    }
}

impl IdentityFile {
    fn bind(path: &Path) -> Result<Self, ErrorCode> {
        let bytes = path.as_os_str().as_encoded_bytes();
        let relative = bytes.strip_prefix(b"/").ok_or(UNSUPPORTED)?;
        if !literal_path(path)
            || relative
                .split(|&byte| byte == b'/')
                .any(|part| part.is_empty() || matches!(part, b"." | b".."))
        {
            return Err(UNSUPPORTED);
        }
        let path = macos_temp_alias(path);
        let (stamp, public) = check(&path)?;
        Ok(Self {
            path,
            stamp,
            public,
        })
    }

    fn revalidate(&self) -> Result<(), ErrorCode> {
        if check(&self.path)? != (self.stamp, self.public) {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }
}

fn check(path: &Path) -> Result<(Stamp, Option<Stamp>), ErrorCode> {
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let mut parents = path.ancestors().skip(1);
    let parent =
        fs::symlink_metadata(parents.next().ok_or(UNSUPPORTED)?).map_err(|_| UNSUPPORTED)?;
    if !parent.is_dir() || parent.uid() != uid || parent.mode() & 0o577 != 0o500 {
        return Err(UNSUPPORTED);
    }
    // SSH reopens by path. Keep the containing tree outside other users'
    // write authority as well. Root-owned sticky temp directories are safe
    // here because every child directory is also checked for trusted ownership.
    for ancestor in parents {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| UNSUPPORTED)?;
        let root_sticky = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        if !meta.is_dir()
            || (meta.uid() != 0 && meta.uid() != uid)
            || (meta.mode() & 0o022 != 0 && !root_sticky)
        {
            return Err(UNSUPPORTED);
        }
    }
    let meta = fs::symlink_metadata(path).map_err(|_| UNSUPPORTED)?;
    if !regular_owned(&meta, uid)
        || meta.mode() & 0o7077 != 0
        || meta.mode() & 0o400 == 0
        || !(1..=MAX_IDENTITY_BYTES).contains(&meta.len())
    {
        return Err(UNSUPPORTED);
    }
    // OpenSSH can implicitly open <identity>.pub even with the agent and
    // certificate auth disabled. Ordinary generated public sidecars are fine.
    let mut public_path = path.as_os_str().to_owned();
    public_path.push(".pub");
    let public = match fs::symlink_metadata(public_path) {
        Ok(meta) if regular_owned(&meta, uid) && meta.mode() & 0o022 == 0 => Some(Stamp::of(&meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        _ => return Err(UNSUPPORTED),
    };
    Ok((Stamp::of(&meta), public))
}

fn regular_owned(meta: &Metadata, uid: u32) -> bool {
    meta.is_file() && meta.uid() == uid && meta.nlink() == 1
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    file: (u64, u64),
    len: u64,
    changed: (i64, i64),
    modified: (i64, i64),
}

impl Stamp {
    fn of(meta: &Metadata) -> Self {
        Self {
            file: (meta.dev(), meta.ino()),
            len: meta.len(),
            changed: (meta.ctime(), meta.ctime_nsec()),
            modified: (meta.mtime(), meta.mtime_nsec()),
        }
    }
}

fn macos_temp_alias(path: &Path) -> PathBuf {
    // macOS exposes /tmp and /var as system aliases. Pass the real spelling
    // to OpenSSH and never resolve a fixture-controlled symlink.
    #[cfg(target_os = "macos")]
    for (alias, canonical) in [("/tmp", "/private/tmp"), ("/var", "/private/var")] {
        if let Ok(relative) = path.strip_prefix(alias) {
            return Path::new(canonical).join(relative);
        }
    }
    path.to_owned()
}

pub(super) fn literal_path(path: &Path) -> bool {
    // These paths go through OpenSSH's own config/token parser, not a shell.
    // Only literal fixture paths are supported; no glob, tilde, percent or env expansion.
    path.is_absolute()
        && path.file_name().is_some()
        && path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'))
}

#[cfg(test)]
pub(in super::super) fn write_identity_fixture(root: &Path) -> PathBuf {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = root.join("identity");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => file
            .write_all(b"synthetic identity for recording executable")
            .expect("write private identity fixture"),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => panic!("cannot create private identity fixture: {error}"),
    }
    path
}
