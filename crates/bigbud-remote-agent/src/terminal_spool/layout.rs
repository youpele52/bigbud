//! On-disk layout: `<state_root>/terminals/<hex(sha256(pty_id))[0..32]>/` holding `meta.json`,
//! `checkpoint.bin` and the rotating `seg-0.raw` / `seg-1.raw` (plan §8.3). Directories are
//! `0700`, files `0600`, and every name is a hash or a fixed literal.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::errors::SpoolError;

pub(super) const TERMINALS_DIR: &str = "terminals";
pub(super) const META_FILE: &str = "meta.json";
pub(super) const CHECKPOINT_FILE: &str = "checkpoint.bin";
pub(super) const SEGMENT_FILES: [&str; 2] = ["seg-0.raw", "seg-1.raw"];
const TEMP_SUFFIX: &str = ".tmp";
const DIR_NAME_LEN: usize = 32;

/// Hash-derived directory name; the PTY id never appears in a path.
pub(super) fn dir_name(pty_id: &str) -> String {
    let digest = Sha256::digest(pty_id.as_bytes());
    let mut name = String::with_capacity(DIR_NAME_LEN);
    for byte in digest.iter().take(DIR_NAME_LEN / 2) {
        name.push(hex_digit(byte >> 4));
        name.push(hex_digit(byte & 0x0f));
    }
    name
}

fn hex_digit(nibble: u8) -> char {
    char::from_digit(u32::from(nibble), 16).unwrap_or('0')
}

pub(super) fn is_spool_dir_name(name: &str) -> bool {
    name.len() == DIR_NAME_LEN
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn validate_pty_id(pty_id: &str) -> Result<(), SpoolError> {
    if pty_id.is_empty() || pty_id.len() > 256 || pty_id.contains('\0') {
        return Err(SpoolError::InvalidArgument("pty id"));
    }
    Ok(())
}

pub(super) fn ensure_private_directory(path: &Path) -> Result<(), SpoolError> {
    let insecure = |error: crate::state::AgentStateError| SpoolError::Insecure(error.to_string());
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            crate::state::create_private_directories(path).map_err(insecure)?;
            crate::state::set_private_permissions(path).map_err(insecure)?;
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    crate::state::assert_secure_directory(path).map_err(insecure)
}

pub(super) fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Opens a segment for appending, creating it owner-only.
pub(super) fn open_segment(path: &Path) -> io::Result<File> {
    let mut options = private_options();
    options.create(true).append(true).read(true);
    options.open(path)
}

/// Writes `bytes` to `<path>.tmp`, fsyncs, renames over `path` and fsyncs the directory, so a
/// reader sees either the old file or the complete new one.
pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = temp_path(path);
    let result = (|| {
        let mut options = private_options();
        options.write(true).create(true).truncate(true);
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_parent(path)
    })();
    if result.is_err() && remove_if_present(&temporary).is_err() {
        // The startup sweep removes any `.tmp` leftover; the original error is what matters.
    }
    result
}

pub(super) fn temp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(TEMP_SUFFIX);
    path.with_file_name(name)
}

pub(super) fn is_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(TEMP_SUFFIX))
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Removes one spool directory. It only ever holds plain files, so no recursion is needed and
/// symlinks are unlinked rather than followed.
pub(super) fn remove_spool_dir(dir: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            remove_if_present(&entry.path())?;
        }
    }
    match fs::remove_dir(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Bytes used by the regular files directly inside `dir`.
pub(super) fn dir_usage(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .fold(0u64, u64::saturating_add)
}
