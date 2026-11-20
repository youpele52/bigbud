pub mod install;

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const DESCRIPTOR_MAGIC: &str = "bigbud-cli-launcher-v1";
const MAX_DESCRIPTOR_BYTES: u64 = 32 * 1024;

pub struct LaunchTarget {
    pub runtime: PathBuf,
    pub entry: PathBuf,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn read_target(executable: &Path) -> io::Result<LaunchTarget> {
    let path = executable.with_extension("launch");
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err(invalid("invalid launcher descriptor"));
    }
    let mut content = String::new();
    std::fs::File::open(path)?
        .take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_string(&mut content)?;
    if content.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err(invalid("launcher descriptor exceeds limit"));
    }
    parse_target(&content)
}

pub fn parse_target(content: &str) -> io::Result<LaunchTarget> {
    let mut lines = content.lines();
    if lines.next() != Some(DESCRIPTOR_MAGIC) {
        return Err(invalid("unrecognized launcher descriptor"));
    }
    let runtime = lines.next().ok_or_else(|| invalid("missing runtime"))?;
    let entry = lines
        .next()
        .ok_or_else(|| invalid("missing server entry"))?;
    if lines.next().is_some() || runtime.contains('\0') || entry.contains('\0') {
        return Err(invalid("malformed launcher descriptor"));
    }
    let target = LaunchTarget {
        runtime: PathBuf::from(runtime),
        entry: PathBuf::from(entry),
    };
    if !target.runtime.is_absolute() || !target.entry.is_absolute() {
        return Err(invalid("launcher paths must be absolute"));
    }
    Ok(target)
}

pub fn command(target: &LaunchTarget, arguments: impl IntoIterator<Item = OsString>) -> Command {
    let mut command = Command::new(&target.runtime);
    command
        .arg(&target.entry)
        .args(arguments)
        .env("ELECTRON_RUN_AS_NODE", "1");
    command
}

pub fn run(executable: &Path, arguments: impl IntoIterator<Item = OsString>) -> io::Result<i32> {
    let target = read_target(executable)?;
    if !target.runtime.is_file() || !target.entry.is_file() {
        return Err(invalid("bundled runtime or CLI entry is missing"));
    }
    let status = command(&target, arguments).status()?;
    // A signal-terminated child has no numeric exit code. Report failure without redispatch.
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests;
