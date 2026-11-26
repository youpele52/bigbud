//! Disposable-fixture guards for the fixture/development launcher argv.
//!
//! These checks are separate from argv parsing: the parser only decides which
//! facts were supplied, while these functions prove the exact disposable
//! namespace and hold the single profile lock.

use super::{AliasConfig, invalid_input};
use std::io;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn validate_snapshot_fixture(
    identity: &std::path::Path,
    known_hosts: &std::path::Path,
    profile_lock: &std::path::Path,
    workspace: Option<&std::path::Path>,
    alias: Option<&AliasConfig>,
    interactive: bool,
) -> io::Result<()> {
    use std::{fs, os::unix::fs::MetadataExt, path::Path};
    let root = identity.parent().ok_or_else(invalid_input)?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let workspace = workspace.ok_or_else(invalid_input)?;
    #[cfg(target_os = "linux")]
    let suffix = if cfg!(target_arch = "aarch64")
        && std::env::var_os("BIGBUD_SSH_OWNER_SNAPSHOT_CANCEL_FIXTURE").as_deref()
            == Some(std::ffi::OsStr::new("approved-disposable"))
        && std::env::var_os("BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF").is_none()
        && std::env::var_os("BIGBUD_SSH_OWNER_GUARDED_WRITE_STAGE_PROOF").is_none()
        && std::env::var_os("BIGBUD_SSH_OWNER_PICKER_JUMP").is_none()
        && workspace == root.join("home/picker's folders; literal")
        && alias.is_none()
        && !interactive
        && fs::symlink_metadata(root.join("home"))?.is_dir()
    {
        name.strip_prefix("bigbud-picker-linux-")
    } else {
        None
    };
    #[cfg(target_os = "macos")]
    let suffix = if workspace == root.join("workspace") && alias.is_none() && !interactive {
        name.strip_prefix("bigbud-snapshot-sshd-")
    } else if workspace == root.join("home/picker's folders; literal")
        && alias.is_some_and(|(file, _)| file == &root.join("owner-alias.conf"))
        && interactive
        && fs::symlink_metadata(root.join("home"))?.is_dir()
    {
        name.strip_prefix("bigbud-picker-sshd-")
    } else {
        None
    };
    if !suffix.is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    }) || root.parent()
        != Some(Path::new(if cfg!(target_os = "linux") {
            "/tmp"
        } else {
            "/private/tmp"
        }))
        || identity != root.join("identity")
        || known_hosts != root.join("known_hosts")
        || profile_lock != root.join("owner.lock")
    {
        return Err(invalid_input());
    }
    let metadata = fs::symlink_metadata(root)?;
    // SAFETY: geteuid simply observes the current process's effective UID.
    let uid = unsafe { libc::geteuid() };
    if (cfg!(target_os = "linux") && uid == 0)
        || !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(invalid_input());
    }
    if !fs::symlink_metadata(workspace)?.is_dir() {
        return Err(invalid_input());
    }
    match fs::symlink_metadata(profile_lock) {
        Ok(lock) if lock.is_file() && lock.uid() == uid && lock.nlink() == 1 => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(invalid_input()),
    }
}

// Every launcher locks the same inode; never unlink it.
pub(crate) fn lock_profile(path: &std::path::Path) -> io::Result<std::fs::File> {
    let lock = std::fs::File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    lock.try_lock().map_err(io::Error::from)?;
    Ok(lock)
}
