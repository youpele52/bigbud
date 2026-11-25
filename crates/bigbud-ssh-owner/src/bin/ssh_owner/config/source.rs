use super::diagnostic::{ConfigFailure, Located};
use super::fixture_fs::{Directory, DirectoryChild};
use super::include::{self, ConfigSources};
use super::paths::{MAX_PATH, literal_parent};
use super::trust_paths::TrustPaths;
use super::{ErrorCode, RouteFacts, UNSUPPORTED};
use sha2::{Digest, Sha256};
use std::ffi::{CString, OsStr};
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
}

struct RootToken {
    path: PathBuf,
    canonical: PathBuf,
    directory_id: FileId,
}

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
    pub(super) fn open(path: &Path) -> Result<Self, ErrorCode> {
        let parent = literal_parent(path, false)?;
        // Unix temp locations can themselves be system aliases (e.g. /var).
        // Canonicalize only the explicitly supplied fixture directory, not
        // its files; the token also checks that this mapping has not changed.
        let original = fs::symlink_metadata(parent).map_err(|_| UNSUPPORTED)?;
        let canonical = fs::canonicalize(parent).map_err(|_| UNSUPPORTED)?;
        let directory = Directory::root(&canonical)?;
        let metadata = directory.metadata()?;
        if !original.is_dir() || FileId::of(&original) != FileId::of(&metadata) {
            return Err(UNSUPPORTED);
        }
        // SAFETY: geteuid takes no arguments and reads the current process only.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            return Err(UNSUPPORTED);
        }
        Ok(Self {
            path: path.to_owned(),
            canonical,
            directory,
            directory_id: FileId::of(&metadata),
            uid,
        })
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

    pub(super) fn config_name(&self) -> Result<&OsStr, ErrorCode> {
        self.path.file_name().ok_or(UNSUPPORTED)
    }

    pub(super) fn directory(&self) -> &Directory {
        &self.directory
    }

    pub(super) fn uid(&self) -> u32 {
        self.uid
    }

    pub(super) fn relative_operand<'a>(&self, path: &'a Path) -> Result<&'a Path, ErrorCode> {
        if path.is_absolute() {
            path.strip_prefix(&self.canonical).or_else(|_| {
                path.strip_prefix(self.path.parent().ok_or(UNSUPPORTED)?)
                    .map_err(|_| UNSUPPORTED)
            })
        } else {
            Ok(path)
        }
    }

    pub(super) fn read_config(
        &self,
        path: &Path,
        private: bool,
    ) -> Result<(FileVersion, Vec<u8>), ErrorCode> {
        let file = self.open_regular(path, private)?;
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
        self.check_read(path, &file, private, &before, bytes.len() as u64)?;
        let digest = Sha256::digest(&bytes).into();
        Ok((
            FileVersion {
                stamp: before,
                digest,
            },
            bytes,
        ))
    }

    pub(super) fn bind(
        self,
        system: Option<Scope>,
        config: ConfigSources,
        alias: &str,
        facts: &RouteFacts,
        identities: &[Located<PathBuf>],
        trust: &TrustPaths,
    ) -> Result<SourceToken, ConfigFailure> {
        let mut trust_files = Vec::with_capacity(trust.user.len() + trust.global.len());
        for path in &trust.user {
            trust_files.push(self.bind_trust(path, &config, false)?);
        }
        for global in &trust.global {
            let scope = if global.system_scope {
                system.as_ref().ok_or(UNSUPPORTED)?
            } else {
                &self
            };
            let token = scope.bind_trust(&global.path, &config, global.system_scope)?;
            // A persistable user file must never also be a global input.
            if trust_files
                .iter()
                .take(trust.user.len())
                .any(|user| user.id == token.id)
            {
                return Err(global.path.diagnostic.reject(UNSUPPORTED));
            }
            trust_files.push(token);
        }
        let mut bound_identities = Vec::with_capacity(identities.len());
        for identity in identities {
            let reject_identity = |code| identity.diagnostic.reject(code);
            let relative = identity
                .value
                .strip_prefix(&self.canonical)
                .map_err(|_| reject_identity(UNSUPPORTED))?;
            let version = self.identity_stamp(relative).map_err(reject_identity)?;
            if trust_files.iter().any(|trust| trust.id == version.id) || config.contains(version.id)
            {
                return Err(reject_identity(UNSUPPORTED));
            }
            bound_identities.push((relative.to_owned(), version));
        }
        Ok(SourceToken {
            alias: alias.to_owned(),
            facts: facts.clone(),
            config,
            identities: bound_identities,
            trust: trust_files,
            user: self.into_root(),
            system: system.map(Scope::into_root),
        })
    }

    fn into_root(self) -> RootToken {
        RootToken {
            path: self.path,
            canonical: self.canonical,
            directory_id: self.directory_id,
        }
    }

    fn bind_trust(
        &self,
        path: &Located<PathBuf>,
        config: &ConfigSources,
        system_scope: bool,
    ) -> Result<TrustToken, ConfigFailure> {
        let reject = |code| path.diagnostic.reject(code);
        let relative = path
            .value
            .strip_prefix(&self.canonical)
            .map_err(|_| reject(UNSUPPORTED))?;
        let id = self.trust_id(relative).map_err(reject)?;
        if config.contains(id) {
            return Err(reject(UNSUPPORTED));
        }
        Ok(TrustToken {
            relative: relative.to_owned(),
            id,
            system_scope,
        })
    }

    fn trust_id(&self, path: &Path) -> Result<FileId, ErrorCode> {
        let file = self.open_scoped_file(path, true, true)?;
        Ok(FileId::of(&file.metadata().map_err(|_| UNSUPPORTED)?))
    }

    fn identity_stamp(&self, path: &Path) -> Result<Stamp, ErrorCode> {
        // Recheck inode and timestamps without ever pulling key contents into
        // the config resolver (which can run before host trust is established).
        let file = self.open_regular(path, true)?;
        let stamp = Stamp::of(&file.metadata().map_err(|_| UNSUPPORTED)?);
        if stamp.len == 0 || stamp.len > MAX_IDENTITY {
            return Err(UNSUPPORTED);
        }
        self.check_read(path, &file, true, &stamp, stamp.len)?;
        Ok(stamp)
    }

    fn open_regular(&self, path: &Path, private: bool) -> Result<File, ErrorCode> {
        self.open_scoped_file(path, private, false)
    }

    fn open_scoped_file(
        &self,
        path: &Path,
        private: bool,
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
                return directory.regular(&name, self.uid, private);
            }
            let DirectoryChild::Directory(next) = directory.child(&name, self.uid)? else {
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
        private: bool,
        before: &Stamp,
        len: u64,
    ) -> Result<(), ErrorCode> {
        let after = file.metadata().map_err(|_| UNSUPPORTED)?;
        let at_path = self
            .open_regular(path, private)?
            .metadata()
            .map_err(|_| UNSUPPORTED)?;
        if len != before.len || *before != Stamp::of(&after) || *before != Stamp::of(&at_path) {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }
}

impl RootToken {
    fn reopen(&self) -> Result<Scope, ErrorCode> {
        let scope = Scope::open(&self.path)?;
        if scope.canonical != self.canonical || scope.directory_id != self.directory_id {
            return Err(UNSUPPORTED);
        }
        Ok(scope)
    }
}

impl SourceToken {
    pub(super) fn revalidate(&self) -> Result<(), ErrorCode> {
        let user = self.user.reopen()?;
        let system = self.system.as_ref().map(RootToken::reopen).transpose()?;
        let (_, config) = include::evaluate(&user, system.as_ref(), &self.alias, &self.facts)
            .map_err(|failure| failure.code)?;
        if config != self.config {
            return Err(UNSUPPORTED);
        }
        for (path, version) in &self.identities {
            if user.identity_stamp(path)? != *version {
                return Err(UNSUPPORTED);
            }
        }
        // Transport compares trust contents at use. Revalidation here binds
        // the complete ordered source list and rejects replaced/unsafe paths.
        for token in &self.trust {
            let scope = if token.system_scope {
                system.as_ref().ok_or(UNSUPPORTED)?
            } else {
                &user
            };
            if scope.trust_id(&token.relative)? != token.id {
                return Err(UNSUPPORTED);
            }
        }
        Ok(())
    }
}

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
