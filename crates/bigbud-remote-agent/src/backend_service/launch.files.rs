use super::{Result, ServiceError};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

pub(super) fn absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(ServiceError::Invalid(
            "managed launch evidence is ambiguous",
        )),
    }
}

#[cfg(unix)]
pub(super) fn lock(path: &Path) -> Result<File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    super::files::canonical(path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let stat = file.metadata()?;
    if !stat.is_file()
        || stat.uid() != super::files::uid()?
        || stat.mode() & 0o7777 != 0o600
        || stat.nlink() != 1
    {
        return Err(ServiceError::Invalid("unsafe managed launch lock"));
    }
    // SAFETY: this descriptor is live and owned; nonblocking flock never dereferences pointers.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(ServiceError::Invalid("managed launch is already owned"));
    }
    same_lock(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
pub(super) fn same_lock(file: &File, path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let open = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if named.dev() != open.dev()
        || named.ino() != open.ino()
        || !named.is_file()
        || named.nlink() != 1
        || named.uid() != super::files::uid()?
        || named.mode() & 0o7777 != 0o600
    {
        return Err(ServiceError::Invalid("managed launch lock changed"));
    }
    Ok(())
}

pub(super) fn boot_id() -> Result<String> {
    let path = Path::new("/proc/sys/kernel/random/boot_id");
    if !cfg!(target_os = "linux") || !fs::symlink_metadata(path)?.is_file() {
        return Err(ServiceError::Unsupported);
    }
    let mut value = String::new();
    File::open(path)?.take(65).read_to_string(&mut value)?;
    let value = value.trim_end_matches('\n');
    if !valid_boot(value) {
        return Err(ServiceError::Invalid("invalid Linux boot identity"));
    }
    Ok(value.into())
}

pub(super) fn valid_boot(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

pub(super) fn receipt(root: &Path, status: u8) -> Result<()> {
    let target = root.join("launch.exit");
    absent(&target)?;
    let temporary = root.join(format!(".launch-exit.service-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    write!(file, "{status}")?;
    file.sync_all()?;
    // No overwrite, including an unexpected receipt from a concurrent or replaced owner.
    fs::hard_link(&temporary, &target)?;
    fs::remove_file(&temporary)?;
    File::open(root)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
pub(super) fn same_executable(
    expected: &Path,
    observed_path: &Path,
    observed: &fs::Metadata,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let named = fs::symlink_metadata(expected)?;
    if observed_path != expected
        || !named.is_file()
        || !observed.is_file()
        || named.dev() != observed.dev()
        || named.ino() != observed.ino()
    {
        return Err(ServiceError::Invalid(
            "running service launcher differs from the pinned managed artifact",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn verify_launcher(expected: &Path) -> Result<()> {
    let executable = Path::new("/proc/self/exe");
    same_executable(
        expected,
        &fs::read_link(executable)?,
        &fs::metadata(executable)?,
    )
}
