//! POSIX proof boundary for the system OpenSSH executables. This gate binds
//! protected OS paths and observes file identity; it is not release attestation.

use super::v1::ErrorCode;
use std::fs::{self, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "linux")]
mod linux_fixture;

const SSH: &str = "/usr/bin/ssh";
const KEYSCAN: &str = "/usr/bin/ssh-keyscan";
const SYSTEM_UID: u32 = 0;
const UNAVAILABLE: ErrorCode = ErrorCode::OwnerUnavailable;

pub(super) struct Images {
    ssh: BoundImage,
    keyscan: BoundImage,
}

pub(super) fn accepts_paths(ssh: &Path, keyscan: &Path) -> bool {
    // Do not canonicalize an untrusted alternative (including a symlink or a
    // pathname that normalizes to the same components) into the allowlist.
    ssh.as_os_str() == SSH && keyscan.as_os_str() == KEYSCAN
}

impl Images {
    pub(super) fn bind(ssh: &Path, keyscan: &Path) -> Result<Self, ErrorCode> {
        if !accepts_paths(ssh, keyscan) {
            #[cfg(test)]
            return Ok(Self {
                ssh: BoundImage::fixture(ssh),
                keyscan: BoundImage::fixture(keyscan),
            });
            #[cfg(not(test))]
            return Err(ErrorCode::ConfigUnsupported);
        }
        let boundary = Boundary::select()?;
        Ok(Self {
            ssh: BoundImage::admit(ssh, boundary)?,
            keyscan: BoundImage::admit(keyscan, boundary)?,
        })
    }

    pub(super) fn ssh(&self) -> Result<Command, ErrorCode> {
        self.ssh.command()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn require_mounted_linux_fixture(&self) -> Result<(), ErrorCode> {
        if !matches!(
            self.ssh.binding,
            Binding::Verified {
                boundary: Boundary::MountedFixture(_),
                ..
            }
        ) {
            return Err(ErrorCode::ConfigUnsupported);
        }
        self.ssh().map(drop)
    }

    pub(super) fn keyscan(&self) -> Result<Command, ErrorCode> {
        self.keyscan.command()
    }
}

struct BoundImage {
    path: PathBuf,
    binding: Binding,
}

enum Binding {
    Verified {
        stamp: ImageBinding,
        boundary: Boundary,
    },
    #[cfg(test)]
    Recorder,
}

#[derive(Clone, Copy)]
enum Boundary {
    System,
    #[cfg(target_os = "linux")]
    MountedFixture(linux_fixture::MountedTools),
}

impl Boundary {
    fn select() -> Result<Self, ErrorCode> {
        #[cfg(target_os = "linux")]
        if linux_fixture::MountedTools::requested() {
            return linux_fixture::MountedTools::bind().map(Self::MountedFixture);
        }
        Ok(Self::System)
    }

    fn owner(self, _path: &Path) -> u32 {
        match self {
            Self::System => SYSTEM_UID,
            #[cfg(target_os = "linux")]
            Self::MountedFixture(tools) => tools.owner(_path),
        }
    }

    fn revalidate(self, _path: &Path) -> Result<(), ErrorCode> {
        match self {
            Self::System => Ok(()),
            #[cfg(target_os = "linux")]
            Self::MountedFixture(_) => linux_fixture::MountedTools::revalidate(_path),
        }
    }
}

#[derive(PartialEq, Eq)]
struct ImageBinding {
    directories: Vec<(u64, u64)>,
    file: FileIdentity,
}

#[derive(PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    mode: u32,
    len: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl BoundImage {
    fn admit(path: &Path, boundary: Boundary) -> Result<Self, ErrorCode> {
        boundary.revalidate(path)?;
        let stamp = inspect(Path::new("/"), path, |path| boundary.owner(path))?;
        Ok(Self {
            path: path.to_owned(),
            binding: Binding::Verified { stamp, boundary },
        })
    }

    #[cfg(test)]
    fn fixture(path: &Path) -> Self {
        // Unit suites use recorders or deliberately nonexistent paths. The
        // actual executable's bootstrap never admits a fixture override.
        Self {
            path: path.to_owned(),
            binding: Binding::Recorder,
        }
    }

    fn command(&self) -> Result<Command, ErrorCode> {
        match &self.binding {
            Binding::Verified { stamp, boundary } => {
                boundary.revalidate(&self.path)?;
                stamp.revalidate(Path::new("/"), &self.path, |path| boundary.owner(path))?;
            }
            #[cfg(test)]
            Binding::Recorder => {}
        }
        // Protected parents and file prevent substitutions by unprivileged
        // users between this check and exec. This is not protection from root.
        Ok(Command::new(&self.path))
    }
}

fn inspect(
    root: &Path,
    path: &Path,
    owner: impl Fn(&Path) -> u32,
) -> Result<ImageBinding, ErrorCode> {
    let relative = path.strip_prefix(root).map_err(|_| UNAVAILABLE)?;
    let mut parts = relative.components();
    let mut cursor = root.to_owned();
    let mut directories = Vec::new();
    loop {
        let stat = fs::symlink_metadata(&cursor).map_err(|_| UNAVAILABLE)?;
        if stat.uid() != owner(&cursor) || stat.mode() & 0o022 != 0 {
            return Err(UNAVAILABLE);
        }
        match parts.next() {
            Some(Component::Normal(name)) if stat.is_dir() => {
                directories.push((stat.dev(), stat.ino()));
                cursor.push(name);
            }
            None if stat.is_file() && stat.mode() & 0o111 != 0 => {
                return Ok(ImageBinding {
                    directories,
                    file: FileIdentity::of(&stat),
                });
            }
            _ => return Err(UNAVAILABLE),
        }
    }
}

impl ImageBinding {
    fn revalidate(
        &self,
        root: &Path,
        path: &Path,
        owner: impl Fn(&Path) -> u32,
    ) -> Result<(), ErrorCode> {
        if inspect(root, path, owner)? != *self {
            return Err(UNAVAILABLE);
        }
        Ok(())
    }
}

impl FileIdentity {
    fn of(stat: &Metadata) -> Self {
        Self {
            dev: stat.dev(),
            ino: stat.ino(),
            mode: stat.mode(),
            len: stat.size(),
            modified: (stat.mtime(), stat.mtime_nsec()),
            changed: (stat.ctime(), stat.ctime_nsec()),
        }
    }
}

#[cfg(test)]
mod tests;
