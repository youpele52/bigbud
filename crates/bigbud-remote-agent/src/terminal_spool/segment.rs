//! Segment record framing. Each PTY output chunk is appended as
//! `[0xB5][sequence u64 LE][length u32 LE][bytes]`, so a crash that truncates the tail of a
//! segment loses only the torn final record and every record keeps its output sequence.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

const MARKER: u8 = 0xB5;
pub(super) const RECORD_HEADER_BYTES: usize = 1 + 8 + 4;
/// Upper bound for one record's payload; PTY reads are far smaller.
pub(super) const MAX_RECORD_BYTES: usize = 1024 * 1024;

/// One output chunk recovered from a spool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpoolChunk {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

pub(super) fn encoded_len(payload: usize) -> usize {
    RECORD_HEADER_BYTES.saturating_add(payload)
}

pub(super) fn encode_into(buffer: &mut Vec<u8>, sequence: u64, bytes: &[u8]) {
    buffer.push(MARKER);
    buffer.extend_from_slice(&sequence.to_le_bytes());
    // Callers reject payloads above MAX_RECORD_BYTES, so the length always fits in u32.
    buffer.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_le_bytes());
    buffer.extend_from_slice(bytes);
}

/// Parses records until the first torn or invalid one; everything before it is trusted.
pub(super) fn decode(mut bytes: &[u8]) -> Vec<SpoolChunk> {
    let mut chunks = Vec::new();
    while let Some((&marker, rest)) = bytes.split_first() {
        if marker != MARKER {
            break;
        }
        let Some((sequence, rest)) = rest.split_first_chunk::<8>() else {
            break;
        };
        let Some((length, rest)) = rest.split_first_chunk::<4>() else {
            break;
        };
        let Ok(length) = usize::try_from(u32::from_le_bytes(*length)) else {
            break;
        };
        if length > MAX_RECORD_BYTES {
            break;
        }
        let Some((payload, rest)) = rest.split_at_checked(length) else {
            break;
        };
        chunks.push(SpoolChunk {
            sequence: u64::from_le_bytes(*sequence),
            bytes: payload.to_vec(),
        });
        bytes = rest;
    }
    chunks
}

/// Reads at most `limit` bytes of a segment; a missing segment is empty.
pub(super) fn read(path: &Path, limit: u64) -> io::Result<Vec<SpoolChunk>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    Ok(decode(&bytes))
}
