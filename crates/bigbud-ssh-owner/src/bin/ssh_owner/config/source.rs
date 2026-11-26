use super::diagnostic::{ConfigFailure, Located};
use super::fixture_fs::{Directory, DirectoryChild};
use super::include::{self, ConfigSources};
use super::paths::{MAX_PATH, literal_parent};
use super::trust_paths::TrustPaths;
use super::{ErrorCode, RouteFacts, UNSUPPORTED};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub(super) const MAX_CONFIG: u64 = 256 * 1024;
const MAX_IDENTITY: u64 = 64 * 1024;

pub(super) struct Scope {
    path: PathBuf,
    canonical: PathBuf,
    directory: Directory,
    directory_id: FileId,
    uid: u32,
    /// U17 production: OpenSSH's own permission checks, not the fixture's.
    openssh: bool,
    /// The literal (uncanonicalized) root directory.
    root: PathBuf,
    /// Where the config lives inside the root; relative operands start here.
    base: PathBuf,
    /// The root is the account home, so `~/` is the root itself.
    home_rooted: bool,
}

struct RootToken {
    path: PathBuf,
    canonical: PathBuf,
    directory_id: FileId,
    openssh: bool,
}

#[path = "source.policy.rs"]
mod policy;
pub(super) use policy::Kind;

pub(super) struct SourceToken {
    user: RootToken,
    system: Option<RootToken>,
    alias: String,
    facts: RouteFacts,
    config: ConfigSources,
    identities: Vec<(PathBuf, Stamp)>,
    trust: Vec<TrustToken>,
}

struct TrustToken {
    relative: PathBuf,
    id: FileId,
    system_scope: bool,
}

impl Scope {
    /// The fixture scope, for tests that open one directly.
    #[cfg(test)]
    pub(super) fn open(path: &Path) -> Result<Self, ErrorCode> {
        Self::open_with(path, false)
    }

    /// `openssh`: the U17 production scope (see `policy`); otherwise the
    /// fixture scope, the config's own private directory.
    pub(super) fn open_with(path: &Path, openssh: bool) -> Result<Self, ErrorCode> {
        let (parent, base, home_rooted) = if openssh {
            policy::production_root(path)?
        } else {
            (
                literal_parent(path, false)?.to_owned(),
                PathBuf::new(),
                false,
            )
        };
        let parent = parent.as_path();
        // Unix temp locations can themselves be system aliases (e.g. /var).
        // Canonicalize only the explicitly supplied fixture directory, not
        // its files; the token also checks that this mapping has not changed.
        // A home-rooted production scope may itself be a symlinked home, which
        // OpenSSH follows; the canonical mapping is still bound and rechecked.
        let original = if openssh {
            fs::metadata(parent)
        } else {
            fs::symlink_metadata(parent)
        }
        .map_err(|_| UNSUPPORTED)?;
        let canonical = fs::canonicalize(parent).map_err(|_| UNSUPPORTED)?;
        let directory = Directory::root(&canonical)?;
        let metadata = directory.metadata()?;
        if !original.is_dir() || FileId::of(&original) != FileId::of(&metadata) {
            return Err(UNSUPPORTED);
        }
        // SAFETY: geteuid takes no arguments and reads the current process only.
        let uid = unsafe { libc::geteuid() };
        let permitted = if openssh {
            policy::trusted_directory(&metadata, uid) && policy::trusted_ancestors(&canonical, uid)
        } else {
            metadata.uid() == uid && metadata.mode() & 0o077 == 0
        };
        if !metadata.is_dir() || !permitted {
            return Err(UNSUPPORTED);
        }
        Ok(Self {
            path: path.to_owned(),
            canonical,
            directory,
            directory_id: FileId::of(&metadata),
            uid,
            openssh,
            root: parent.to_owned(),
            base,
            home_rooted,
        })
    }

    pub(super) fn openssh(&self) -> bool {
        self.openssh
    }

    pub(super) fn home_rooted(&self) -> bool {
        self.home_rooted
    }

    pub(super) fn check_length(&self, relative: &Path) -> Result<(), ErrorCode> {
        if self.canonical.as_os_str().len() + 1 + relative.as_os_str().len() > MAX_PATH {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }

    pub(super) fn absolute(
        &self,
        relative: &Path,
        trust_basename: bool,
    ) -> Result<PathBuf, ErrorCode> {
        let absolute = self.canonical.join(relative);
        literal_parent(&absolute, trust_basename)?;
        Ok(absolute)
    }

    /// The top-level config, relative to the root.
    pub(super) fn config_name(&self) -> Result<PathBuf, ErrorCode> {
        Ok(self.base.join(self.path.file_name().ok_or(UNSUPPORTED)?))
    }

    pub(super) fn directory(&self) -> &Directory {
        &self.directory
    }

    pub(super) fn uid(&self) -> u32 {
        self.uid
    }

    /// Absolute operands must lie under the root; relative ones start at the
    /// config's directory (OpenSSH: `~/.ssh` for a user config).
    pub(super) fn relative_operand(&self, path: &Path) -> Result<PathBuf, ErrorCode> {
        if path.is_absolute() {
            path.strip_prefix(&self.canonical)
                .or_else(|_| path.strip_prefix(&self.root))
                .map(Path::to_owned)
                .map_err(|_| UNSUPPORTED)
        } else {
            Ok(self.base.join(path))
        }
    }

    pub(super) fn read_config(
        &self,
        path: &Path,
        private: bool,
    ) -> Result<(FileVersion, Vec<u8>), ErrorCode> {
        let kind = Kind::Config { private };
        let file = self.open_regular(path, kind)?;
        let before = Stamp::of(&file.metadata().map_err(|_| UNSUPPORTED)?);
        if before.len > MAX_CONFIG {
            return Err(UNSUPPORTED);
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_CONFIG + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| UNSUPPORTED)?;
        if bytes.len() as u64 > MAX_CONFIG {
            return Err(UNSUPPORTED);
        }
        self.check_read(path, &file, kind, &before, bytes.len() as u64)?;
        let digest = Sha256::digest(&bytes).into();
        Ok((
            FileVersion {
                stamp: before,
                digest,
            },
            bytes,
        ))
    }

    fn trust_id(&self, path: &Path) -> Result<FileId, ErrorCode> {
        let file = self.open_scoped_file(path, Kind::Trust, true)?;
        Ok(FileId::of(&file.metadata().map_err(|_| UNSUPPORTED)?))
    }

    fn identity_stamp(&self, path: &Path) -> Result<Stamp, ErrorCode> {
        // Recheck inode and timestamps without ever pulling key contents into
        // the config resolver (which can run before host trust is established).
        let file = self.open_regular(path, Kind::Key)?;
        let stamp = Stamp::of(&file.metadata().map_err(|_| UNSUPPORTED)?);
        if stamp.len == 0 || stamp.len > MAX_IDENTITY {
            return Err(UNSUPPORTED);
        }
        self.check_read(path, &file, Kind::Key, &stamp, stamp.len)?;
        Ok(stamp)
    }

    fn open_regular(&self, path: &Path, kind: Kind) -> Result<File, ErrorCode> {
        self.open_scoped_file(path, kind, false)
    }

    fn open_scoped_file(
        &self,
        path: &Path,
        kind: Kind,
        trust_basename: bool,
    ) -> Result<File, ErrorCode> {
        self.check_length(path)?;
        let mut parts = path
            .as_os_str()
            .as_encoded_bytes()
            .split(|&byte| byte == b'/')
            .peekable();
        let mut child = None;
        while let Some(bytes) = parts.next() {
            let last = parts.peek().is_none();
            if bytes.is_empty()
                || matches!(bytes, b"." | b"..")
                || !bytes.iter().copied().all(|byte| {
                    include::literal_byte(byte) || (last && trust_basename && byte == b' ')
                })
            {
                return Err(UNSUPPORTED);
            }
            let name = CString::new(bytes).map_err(|_| UNSUPPORTED)?;
            let directory = child.as_ref().unwrap_or(&self.directory);
            if last {
                let (private, allow_root) = kind.rule(self.openssh);
                return directory.regular(&name, self.uid, private, allow_root);
            }
            let DirectoryChild::Directory(next) = directory.child(&name, self.uid, self.openssh)?
            else {
                return Err(UNSUPPORTED);
            };
            child = Some(next);
        }
        Err(UNSUPPORTED)
    }

    fn check_read(
        &self,
        path: &Path,
        file: &File,
        kind: Kind,
        before: &Stamp,
        len: u64,
    ) -> Result<(), ErrorCode> {
        let after = file.metadata().map_err(|_| UNSUPPORTED)?;
        let at_path = self
            .open_regular(path, kind)?
            .metadata()
            .map_err(|_| UNSUPPORTED)?;
        if len != before.len || *before != Stamp::of(&after) || *before != Stamp::of(&at_path) {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }
}

#[path = "source.token.rs"]
mod token;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct FileId(u64, u64);

impl FileId {
    fn of(metadata: &Metadata) -> Self {
        Self(metadata.dev(), metadata.ino())
    }
}

#[derive(PartialEq, Eq)]
struct Stamp {
    id: FileId,
    len: u64,
    changed: (i64, i64),
    modified: (i64, i64),
}

impl Stamp {
    fn of(metadata: &Metadata) -> Self {
        Self {
            id: FileId::of(metadata),
            len: metadata.len(),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
        }
    }
}

#[derive(PartialEq, Eq)]
pub(super) struct FileVersion {
    stamp: Stamp,
    digest: [u8; 32],
}

impl FileVersion {
    pub(super) fn id(&self) -> FileId {
        self.stamp.id
    }
}
