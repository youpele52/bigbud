use super::{Result, ServiceError};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;

pub(super) fn uid() -> Result<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no pointer arguments and does not mutate process state.
        Ok(unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    Err(ServiceError::Unsupported)
}

pub(super) fn canonical(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|value| value.chars().any(char::is_control))
        || fs::canonicalize(path)?.as_os_str() != path.as_os_str()
    {
        return Err(ServiceError::Invalid(
            "service paths must be absolute and canonical",
        ));
    }
    Ok(())
}

pub(super) fn directory(path: &Path, modes: &[u32]) -> Result<()> {
    canonical(path)?;
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(not(unix))]
    let _ = (&metadata, modes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.is_dir()
            && metadata.uid() == uid()?
            && modes.contains(&(metadata.mode() & 0o7777))
        {
            return Ok(());
        }
    }
    Err(ServiceError::Invalid(
        "service directories must be owned with safe permissions",
    ))
}

#[derive(Clone, Copy)]
pub(super) enum FileKind {
    Private,
    Epoch,
    ManagedExecutable,
    Executable,
    Data,
}

fn open(path: &Path, kind: FileKind) -> Result<File> {
    #[cfg(not(unix))]
    let _ = kind;
    canonical(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let file = options.open(path)?;
        let stat = file.metadata()?;
        let private = matches!(kind, FileKind::Private | FileKind::Epoch);
        let managed = matches!(kind, FileKind::ManagedExecutable);
        let executable = managed || matches!(kind, FileKind::Executable);
        let owner = if private || managed {
            stat.uid() == uid()?
        } else {
            stat.uid() == 0 || stat.uid() == uid()?
        };
        let mode = stat.mode() & 0o7777;
        if !stat.is_file()
            || stat.nlink() != 1
            || !owner
            || mode & 0o022 != 0
            || (private && mode != 0o600 && !(matches!(kind, FileKind::Epoch) && mode == 0o700))
            || (managed && mode != 0o700)
            || (executable && mode & 0o111 == 0)
        {
            return Err(ServiceError::Invalid(
                "service files have unsafe type, owner, mode or links",
            ));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    Err(ServiceError::Unsupported)
}

pub(super) fn read_private(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    read_bounded(path, maximum, FileKind::Private)
}

pub(super) fn read_epoch(path: &Path) -> Result<Vec<u8>> {
    read_bounded(path, 256, FileKind::Epoch)
}

pub(super) fn private_file(path: &Path) -> Result<()> {
    drop(open(path, FileKind::Private)?);
    Ok(())
}

fn read_bounded(path: &Path, maximum: u64, kind: FileKind) -> Result<Vec<u8>> {
    let mut file = open(path, kind)?;
    let before = file.metadata()?;
    let size = before.len();
    if size == 0 || size > maximum {
        return Err(ServiceError::Invalid(
            "private service file exceeds its bounded size",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(path)?;
        if after.uid() != uid()?
            || before.mode() != after.mode()
            || after.nlink() != 1
            || named.ino() != after.ino()
            || named.dev() != after.dev()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(ServiceError::Invalid(
                "private service file changed while reading",
            ));
        }
    }
    if bytes.len() as u64 != size || after.len() != size {
        return Err(ServiceError::Invalid(
            "private service file changed while reading",
        ));
    }
    Ok(bytes)
}

pub(super) fn hash_file(path: &Path, expected: &str, kind: FileKind) -> Result<()> {
    let mut file = open(path, kind)?;
    let before = file.metadata()?;
    const MAXIMUM: u64 = 512 * 1024 * 1024;
    if before.len() == 0 || before.len() > MAXIMUM {
        return Err(ServiceError::Invalid(
            "service artifact exceeds its bounded size",
        ));
    }
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAXIMUM {
            return Err(ServiceError::Invalid(
                "service artifact grew during verification",
            ));
        }
        digest.update(
            buffer
                .get(..count)
                .ok_or(ServiceError::Invalid("invalid artifact read"))?,
        );
    }
    let after = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(path)?;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.mtime() != after.mtime()
            || before.ctime_nsec() != after.ctime_nsec()
            || before.ctime() != after.ctime()
            || named.ino() != after.ino()
            || named.dev() != after.dev()
        {
            return Err(ServiceError::Invalid(
                "service artifact changed during verification",
            ));
        }
    }
    if total != before.len()
        || total != after.len()
        || format!("{:x}", digest.finalize()) != expected
    {
        return Err(ServiceError::Invalid(
            "service artifact does not match its immutable byte pin",
        ));
    }
    Ok(())
}
