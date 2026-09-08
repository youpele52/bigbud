use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use super::{WorkspaceError, map_io};

#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    canonical_root: PathBuf,
    #[cfg(unix)]
    root_directory: Arc<fs::File>,
}

impl WorkspaceRoot {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        if fs::symlink_metadata(root.as_ref())
            .map_err(map_io)?
            .file_type()
            .is_symlink()
        {
            return Err(WorkspaceError::SymlinkComponent);
        }
        let canonical_root = fs::canonicalize(root).map_err(map_io)?;
        if !fs::metadata(&canonical_root).map_err(map_io)?.is_dir() {
            return Err(WorkspaceError::RootNotDirectory);
        }
        #[cfg(unix)]
        let root_directory = fs::File::open(&canonical_root).map_err(map_io)?;
        Ok(Self {
            canonical_root,
            #[cfg(unix)]
            root_directory: Arc::new(root_directory),
        })
    }

    pub fn root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn resolve_directory(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let path = self.resolve_existing(relative_path)?;
        if !fs::metadata(&path).map_err(map_io)?.is_dir() {
            return Err(WorkspaceError::NotDirectory);
        }
        Ok(path)
    }

    pub(super) fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = validate_relative_path(relative_path)?;
        let mut current = self.canonical_root.clone();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
            };
            current.push(name);
            let metadata = fs::symlink_metadata(&current).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    WorkspaceError::NotFound(relative_path.to_owned())
                } else {
                    WorkspaceError::Io(error)
                }
            })?;
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::SymlinkComponent);
            }
        }
        let canonical = fs::canonicalize(&current).map_err(map_io)?;
        if !canonical.starts_with(&self.canonical_root) {
            return Err(WorkspaceError::OutsideRoot);
        }
        Ok(canonical)
    }

    #[cfg(unix)]
    pub(super) fn open_file(&self, relative_path: &str) -> Result<fs::File, WorkspaceError> {
        let relative = validate_relative_path(relative_path)?;
        let components = relative
            .components()
            .map(|component| match component {
                Component::Normal(name) => Ok(name.to_owned()),
                _ => Err(WorkspaceError::InvalidPath(relative_path.to_owned())),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if components.is_empty() {
            let current = CString::new(".")
                .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
            let descriptor =
                open_directory_at(self.root_directory.as_raw_fd(), &current).map_err(map_io)?;
            return Ok(unsafe { fs::File::from_raw_fd(descriptor) });
        }

        let mut directory = self.root_directory.try_clone().map_err(map_io)?;
        for (index, component) in components.iter().enumerate() {
            let name = CString::new(component.as_bytes())
                .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
            let last = index + 1 == components.len();
            let flags = if last {
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW
            } else {
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW
            };
            let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                return Err(map_open_error(relative_path));
            }
            let opened = unsafe { fs::File::from_raw_fd(descriptor) };
            if last {
                return Ok(opened);
            }
            directory = opened;
        }
        Err(WorkspaceError::NotFound(relative_path.to_owned()))
    }

    #[cfg(unix)]
    pub(super) fn open_or_create_directory(
        &self,
        relative_path: &Path,
    ) -> Result<fs::File, WorkspaceError> {
        let mut directory = self.root_directory.try_clone().map_err(map_io)?;
        for component in relative_path.components() {
            let Component::Normal(name) = component else {
                return Err(WorkspaceError::InvalidPath(
                    relative_path.display().to_string(),
                ));
            };
            let name = CString::new(name.as_bytes())
                .map_err(|_| WorkspaceError::InvalidPath(relative_path.display().to_string()))?;
            let descriptor = open_directory_at(directory.as_raw_fd(), &name);
            let descriptor = match descriptor {
                Ok(descriptor) => descriptor,
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                    let created =
                        unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                    if created < 0 {
                        let create_error = std::io::Error::last_os_error();
                        if create_error.raw_os_error() != Some(libc::EEXIST) {
                            return Err(map_io(create_error));
                        }
                    }
                    open_directory_at(directory.as_raw_fd(), &name).map_err(|open_error| {
                        map_directory_open_error(&open_error, relative_path)
                    })?
                }
                Err(error) => return Err(map_directory_open_error(&error, relative_path)),
            };
            directory = unsafe { fs::File::from_raw_fd(descriptor) };
        }
        Ok(directory)
    }

    #[cfg(not(unix))]
    pub(super) fn open_file(&self, relative_path: &str) -> Result<fs::File, WorkspaceError> {
        fs::File::open(self.resolve_existing(relative_path)?).map_err(map_io)
    }

    #[cfg(not(unix))]
    pub(super) fn resolve_or_create_directory(
        &self,
        relative_path: &Path,
    ) -> Result<PathBuf, WorkspaceError> {
        let mut current = self.canonical_root.clone();
        for component in relative_path.components() {
            let Component::Normal(name) = component else {
                return Err(WorkspaceError::InvalidPath(
                    relative_path.display().to_string(),
                ));
            };
            current.push(name);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(WorkspaceError::SymlinkComponent);
                    }
                    if !metadata.is_dir() {
                        return Err(WorkspaceError::NotDirectory);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(map_io)?;
                }
                Err(error) => return Err(WorkspaceError::Io(error)),
            }
        }
        Ok(current)
    }

    pub(super) fn relative_path(&self, path: &Path) -> Result<String, WorkspaceError> {
        path.strip_prefix(&self.canonical_root)
            .map_err(|_| WorkspaceError::OutsideRoot)
            .and_then(|relative| {
                relative
                    .to_str()
                    .map(|value| value.replace('\\', "/"))
                    .ok_or_else(|| WorkspaceError::InvalidPath("non-UTF-8 path".to_owned()))
            })
    }
}

pub(super) fn validate_relative_path(relative_path: &str) -> Result<PathBuf, WorkspaceError> {
    if relative_path.contains('\0') || relative_path.contains('\\') {
        return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
    }
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => {
                return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
            }
        }
    }
    Ok(normalized)
}

#[cfg(unix)]
fn map_open_error(relative_path: &str) -> WorkspaceError {
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ELOOP)
        || error.kind() == std::io::ErrorKind::NotADirectory
    {
        WorkspaceError::SymlinkComponent
    } else if error.kind() == std::io::ErrorKind::NotFound {
        WorkspaceError::NotFound(relative_path.to_owned())
    } else {
        WorkspaceError::Io(error)
    }
}

#[cfg(unix)]
fn open_directory_at(directory_fd: std::os::unix::io::RawFd, name: &CString) -> io::Result<i32> {
    let descriptor = unsafe {
        libc::openat(
            directory_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(descriptor)
    }
}

#[cfg(unix)]
fn map_directory_open_error(error: &io::Error, relative_path: &Path) -> WorkspaceError {
    if error.raw_os_error() == Some(libc::ELOOP) || error.kind() == io::ErrorKind::NotADirectory {
        WorkspaceError::SymlinkComponent
    } else if error.kind() == io::ErrorKind::NotFound {
        WorkspaceError::NotFound(relative_path.display().to_string())
    } else {
        WorkspaceError::Io(io::Error::new(error.kind(), error.to_string()))
    }
}
