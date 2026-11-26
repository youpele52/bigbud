//! `checkpoint.bin`: an opaque screen-model blob (R1 owns its contents) behind a self-checking
//! header. Written via `.tmp`, fsync, rename; a torn or tampered file reads as "no checkpoint".

use std::fs;
use std::io;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::layout::write_atomic;

const MAGIC: &[u8; 8] = b"BBSPCKP1";
/// Magic, `through_sequence` (u64 LE), blob length (u64 LE) and the blob's SHA-256.
pub(super) const HEADER_BYTES: u64 = 8 + 8 + 8 + 32;

/// A durable screen checkpoint covering every output chunk up to and including
/// `through_sequence`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpoolCheckpoint {
    pub through_sequence: u64,
    pub blob: Vec<u8>,
}

pub(super) fn encode(through_sequence: u64, blob: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(blob.len().saturating_add(56));
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&through_sequence.to_le_bytes());
    bytes.extend_from_slice(&(blob.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&Sha256::digest(blob));
    bytes.extend_from_slice(blob);
    bytes
}

pub(super) fn decode(bytes: &[u8]) -> Option<SpoolCheckpoint> {
    let (magic, rest) = bytes.split_first_chunk::<8>()?;
    if magic != MAGIC {
        return None;
    }
    let (through, rest) = rest.split_first_chunk::<8>()?;
    let (length, rest) = rest.split_first_chunk::<8>()?;
    let (digest, blob) = rest.split_first_chunk::<32>()?;
    let length = usize::try_from(u64::from_le_bytes(*length)).ok()?;
    if blob.len() != length || Sha256::digest(blob).as_slice() != digest {
        return None;
    }
    Some(SpoolCheckpoint {
        through_sequence: u64::from_le_bytes(*through),
        blob: blob.to_vec(),
    })
}

pub(super) fn store(path: &Path, through_sequence: u64, blob: &[u8]) -> io::Result<()> {
    write_atomic(path, &encode(through_sequence, blob))
}

/// Reads a checkpoint, treating a missing, truncated or corrupt file as absent.
pub(super) fn load(path: &Path, max_blob: usize) -> io::Result<Option<SpoolCheckpoint>> {
    let limit = max_blob as u64 + HEADER_BYTES;
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > limit => return Ok(None),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    match fs::read(path) {
        Ok(bytes) => Ok(decode(&bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
