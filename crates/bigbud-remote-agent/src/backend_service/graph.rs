//! Config-pinned projection of an already signature-verified complete executable graph.
//! This guard runs before any Node code, including the credential-free capability probe.
use super::{Result, ServiceConfig, ServiceError, files};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[path = "graph.files.rs"]
mod graph_files;
#[cfg(test)]
#[path = "graph.tests.rs"]
mod tests;
const MAX_FILES: usize = 16_384;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
#[derive(Debug)]
struct Member {
    sha: String,
    size: u64,
    mode: u32,
}
fn invalid() -> ServiceError {
    ServiceError::Invalid("backend executable graph receipt or membership is invalid")
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.split('/').count() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@_.+/-".contains(&b))
        && value
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn field<'a>(lines: &mut impl Iterator<Item = &'a str>, name: &str) -> Result<&'a str> {
    lines
        .next()
        .and_then(|line| line.strip_prefix(name))
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)
}
pub(super) fn verify(config: &ServiceConfig) -> Result<()> {
    let bytes = files::read_private(&config.receipt_path(), 16 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&bytes)) != config.receipt_sha256 {
        return Err(invalid());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    if !text.ends_with('\n') {
        return Err(invalid());
    }
    let mut lines = text.split_terminator('\n');
    if lines.next() != Some("bigbud-backend-graph-receipt=1") {
        return Err(invalid());
    }
    let root = PathBuf::from(field(&mut lines, "root=")?);
    let root_dev = field(&mut lines, "root_dev=")?
        .parse::<u64>()
        .map_err(|_| invalid())?;
    let root_ino = field(&mut lines, "root_ino=")?
        .parse::<u64>()
        .map_err(|_| invalid())?;
    let root_ctime = field(&mut lines, "root_ctime_ns=")?
        .parse::<i128>()
        .map_err(|_| invalid())?;
    if !digest(field(&mut lines, "manifest_sha256=")?) {
        return Err(invalid());
    }
    let node = field(&mut lines, "node=")?;
    let entry = field(&mut lines, "entry=")?;
    if !relative(node)
        || !relative(entry)
        || node == entry
        || root.join(node) != config.node_binary
        || root.join(entry) != config.backend_entry
    {
        return Err(invalid());
    }
    let mut members = BTreeMap::new();
    let mut total = 0_u64;
    let mut prior = "";
    for line in lines {
        let parts: Vec<_> = line
            .strip_prefix("file=")
            .ok_or_else(invalid)?
            .splitn(5, '\t')
            .collect();
        let [sha, size_text, mode_text, path] = parts.as_slice() else {
            return Err(invalid());
        };
        if !digest(sha) || !relative(path) || *path <= prior {
            return Err(invalid());
        }
        if members.len() >= MAX_FILES {
            return Err(ServiceError::Invalid(
                "backend executable graph exceeds file budget",
            ));
        }
        let size = size_text.parse::<u64>().map_err(|_| invalid())?;
        if size.to_string() != *size_text {
            return Err(invalid());
        }
        let mode = match *mode_text {
            "600" => 0o600,
            "700" => 0o700,
            _ => return Err(invalid()),
        };
        total =
            total
                .checked_add(size)
                .filter(|n| *n <= MAX_BYTES)
                .ok_or(ServiceError::Invalid(
                    "backend executable graph exceeds byte budget",
                ))?;
        prior = path;
        members.insert(
            (*path).to_owned(),
            Member {
                sha: (*sha).into(),
                size,
                mode,
            },
        );
    }
    let binary = members.get(node).ok_or_else(invalid)?;
    let backend = members.get(entry).ok_or_else(invalid)?;
    if binary.sha != config.node_sha256
        || binary.mode != 0o700
        || binary.size == 0
        || backend.sha != config.backend_sha256
        || backend.size == 0
    {
        return Err(invalid());
    }
    graph_files::verify(Path::new(&root), &members, (root_dev, root_ino, root_ctime))?;
    if files::read_private(&config.receipt_path(), 16 * 1024 * 1024)? != bytes {
        return Err(invalid());
    }
    Ok(())
}
