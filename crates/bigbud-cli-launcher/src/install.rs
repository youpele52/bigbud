use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{DESCRIPTOR_MAGIC, parse_target};

const MARKER: &str = "bigbud-cli-owned-v1";

fn invalid() -> io::Error {
    io::Error::other("unrecognized or changed launcher installation; existing files preserved")
}
fn regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err(invalid()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
fn read_bytes(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    if !regular(path)? {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(invalid());
    }
    Ok(bytes)
}
fn atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(invalid)?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(invalid)?;
    let prefix = format!("{stem}.tmp-");
    let leftovers = fs::read_dir(parent)?
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .take(8)
        .count();
    if leftovers >= 8 {
        return Err(io::Error::other(
            "BIGBUD_CLI_RECOVERY_LIMIT: inspect interrupted installation files",
        ));
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let mut created = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        created = true;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if created && temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    result
}
fn pointer(root: &Path, name: &str) -> io::Result<Option<String>> {
    let path = root.join(name);
    if !regular(&path)? {
        return Ok(None);
    }
    let id = String::from_utf8(read_bytes(&path, 80)?).map_err(io::Error::other)?;
    if !id.starts_with("g-")
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || c == b'g' || c == b'-')
        || id.len() > 80
    {
        return Err(invalid());
    }
    Ok(Some(id))
}
fn generation(root: &Path, id: &str) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let dir = root.join(id);
    if !fs::symlink_metadata(&dir)?.is_dir() {
        return Err(invalid());
    }
    let exe = dir.join("launcher");
    let descriptor = dir.join("descriptor");
    if !regular(&exe)? || !regular(&descriptor)? {
        return Err(invalid());
    }
    Ok((
        read_bytes(&exe, 16 * 1024 * 1024)?,
        read_bytes(&descriptor, 32768)?,
    ))
}
fn matches(path: &Path, alternatives: &[&[u8]]) -> io::Result<bool> {
    if !regular(path)? {
        return Ok(true);
    }
    let bytes = read_bytes(path, 16 * 1024 * 1024)?;
    Ok(alternatives.iter().any(|candidate| bytes == *candidate))
}
fn publish(root: &Path, destination: &Path, id: &str) -> io::Result<()> {
    let next = generation(root, id)?;
    let current = pointer(root, "current")?
        .map(|id| generation(root, &id))
        .transpose()?;
    let mut executables = vec![next.0.as_slice()];
    let mut descriptors = vec![next.1.as_slice()];
    if let Some(ref current) = current {
        executables.push(&current.0);
        descriptors.push(&current.1);
    }
    let descriptor_path = destination.with_extension("launch");
    if !matches(destination, &executables)? || !matches(&descriptor_path, &descriptors)? {
        return Err(invalid());
    }
    atomic(&descriptor_path, &next.1)?;
    atomic(destination, &next.0)?;
    atomic(&root.join("current"), id.as_bytes())?;
    fs::remove_file(root.join("pending"))?;
    Ok(())
}
fn cleanup(root: &Path, previous: Option<&str>, current: &str) -> io::Result<()> {
    let Some(previous) = previous else {
        return Ok(());
    };
    if previous == current {
        return Ok(());
    }
    let path = root.join(previous);
    let names = fs::read_dir(&path)?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    if names.len() != 2 || !names.iter().all(|n| n == "launcher" || n == "descriptor") {
        return Ok(());
    }
    if !regular(&path.join("launcher"))? || !regular(&path.join("descriptor"))? {
        return Ok(());
    }
    fs::remove_file(path.join("launcher"))?;
    fs::remove_file(path.join("descriptor"))?;
    fs::remove_dir(path)
}

/// OS lock release follows process death; immutable pending generations make publication retryable.
pub fn install(source: &Path, destination: &Path, runtime: &Path, entry: &Path) -> io::Result<()> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err(invalid());
    }
    let descriptor = format!(
        "{DESCRIPTOR_MAGIC}\n{}\n{}\n",
        runtime.display(),
        entry.display()
    );
    parse_target(&descriptor)?;
    if descriptor.len() > 32768 || !regular(source)? || !regular(runtime)? || !regular(entry)? {
        return Err(invalid());
    }
    let parent = destination.parent().ok_or_else(invalid)?;
    fs::create_dir_all(parent)?;
    let lock_path = destination.with_extension("install-lock");
    regular(&lock_path)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
        std::fs::TryLockError::Error(error) => error,
    })?;
    let root = destination.with_extension("launcher-state");
    if root.exists() {
        if !fs::symlink_metadata(&root)?.is_dir()
            || !regular(&root.join("marker"))?
            || read_bytes(&root.join("marker"), 64)? != MARKER.as_bytes()
        {
            return Err(invalid());
        }
    } else {
        let temporary = destination.with_extension(format!("state-{}", std::process::id()));
        fs::create_dir(&temporary)?;
        fs::write(temporary.join("marker"), MARKER)?;
        fs::rename(&temporary, &root)?;
    }
    if let Some(id) = pointer(&root, "pending")? {
        let previous = pointer(&root, "current")?;
        publish(&root, destination, &id)?;
        cleanup(&root, previous.as_deref(), &id)?;
    }
    let old = pointer(&root, "current")?;
    match old {
        Some(ref id) => {
            let current = generation(&root, id)?;
            if !matches(destination, &[&current.0])?
                || !matches(&destination.with_extension("launch"), &[&current.1])?
            {
                return Err(invalid());
            }
        }
        None => {
            if regular(destination)? || regular(&destination.with_extension("launch"))? {
                return Err(invalid());
            }
        }
    }
    let generations = fs::read_dir(&root)?
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|e| e.file_name().to_string_lossy().starts_with("g-"))
        .take(4)
        .count();
    if generations >= 4 {
        return Err(io::Error::other(
            "BIGBUD_CLI_RECOVERY_LIMIT: inspect interrupted installation files",
        ));
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let id = format!("g-{}-{nanos}", std::process::id());
    let dir = root.join(&id);
    fs::create_dir(&dir)?;
    let source_bytes = read_bytes(source, 16 * 1024 * 1024)?;
    for (name, bytes) in [
        ("launcher", source_bytes.as_slice()),
        ("descriptor", descriptor.as_bytes()),
    ] {
        let mut file = File::create(dir.join(name))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    atomic(&root.join("pending"), id.as_bytes())?;
    publish(&root, destination, &id)?;
    cleanup(&root, old.as_deref(), &id)
}

#[cfg(test)]
#[path = "install.tests.rs"]
mod tests;
