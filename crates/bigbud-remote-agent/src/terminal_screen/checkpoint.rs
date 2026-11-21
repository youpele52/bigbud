//! `checkpoint`/`restore`: an opaque, self-validating blob (stored by the R2 spool) that
//! rebuilds an equivalent model. It carries a full-fidelity snapshot plus the exclusion marks
//! re-expressed for the restored rows, so a restored model keeps reporting them honestly.

use super::marks::{Marks, take, take_u8, take_u32};
use super::model::{ScreenError, ScreenModel};
use super::scanner::TAIL_CAP;
use super::serialize::{MAX_ANSI_UTF8_BYTES, SnapshotError, SnapshotLimits};
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 7] = b"BBSCRN\0";
const VERSION: u8 = 1;
const DIGEST_BYTES: usize = 32;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CheckpointError {
    #[error("screen checkpoint is malformed: {0}")]
    Malformed(&'static str),
    #[error("screen checkpoint version {0} is not supported")]
    Version(u8),
    #[error("screen checkpoint digest does not match its contents")]
    Digest,
    #[error(transparent)]
    Screen(#[from] ScreenError),
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
}

impl ScreenModel {
    pub fn checkpoint(&self) -> Result<Vec<u8>, CheckpointError> {
        let snapshot = self.snapshot(&SnapshotLimits::default())?;
        let mut out =
            Vec::with_capacity(snapshot.ansi.len() + snapshot.pending_escape_tail.len() + 128);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.extend_from_slice(&snapshot.cols.to_be_bytes());
        out.extend_from_slice(&snapshot.rows.to_be_bytes());
        let scrollback = u32::try_from(self.scrollback_capacity()).unwrap_or(u32::MAX);
        out.extend_from_slice(&scrollback.to_be_bytes());
        out.push(u8::from(self.is_partial()));
        snapshot.restored_marks.encode(&mut out);
        for part in [snapshot.ansi.as_bytes(), &snapshot.pending_escape_tail] {
            out.extend_from_slice(&u32::try_from(part.len()).unwrap_or(u32::MAX).to_be_bytes());
            out.extend_from_slice(part);
        }
        let digest = Sha256::digest(&out);
        out.extend_from_slice(&digest);
        Ok(out)
    }

    pub fn restore(blob: &[u8]) -> Result<Self, CheckpointError> {
        let split = blob
            .len()
            .checked_sub(DIGEST_BYTES)
            .ok_or(CheckpointError::Malformed("truncated"))?;
        let (body, digest) = blob.split_at(split);
        if Sha256::digest(body).as_slice() != digest {
            return Err(CheckpointError::Digest);
        }
        let mut input = body;
        let malformed = |what| CheckpointError::Malformed(what);
        if take(&mut input, MAGIC.len()) != Some(MAGIC.as_slice()) {
            return Err(malformed("magic"));
        }
        let version = take_u8(&mut input).ok_or(malformed("version"))?;
        if version != VERSION {
            return Err(CheckpointError::Version(version));
        }
        let geometry = take(&mut input, 4).ok_or(malformed("geometry"))?;
        let cols = u16::from_be_bytes([
            geometry.first().copied().unwrap_or(0),
            geometry.get(1).copied().unwrap_or(0),
        ]);
        let rows = u16::from_be_bytes([
            geometry.get(2).copied().unwrap_or(0),
            geometry.get(3).copied().unwrap_or(0),
        ]);
        let scrollback = take_u32(&mut input).ok_or(malformed("scrollback"))?;
        let partial = take_u8(&mut input).ok_or(malformed("flags"))? & 1 == 1;
        let marks = Marks::decode(&mut input).ok_or(malformed("marks"))?;
        let ansi = take_part(&mut input, MAX_ANSI_UTF8_BYTES).ok_or(malformed("ansi"))?;
        let tail = take_part(&mut input, TAIL_CAP).ok_or(malformed("tail"))?;
        if !input.is_empty() {
            return Err(malformed("trailing bytes"));
        }
        let scrollback = usize::try_from(scrollback).map_err(|_| malformed("scrollback"))?;
        let mut model = Self::new(cols, rows, scrollback)?;
        let _queries = model.feed(ansi);
        let _queries = model.feed(tail);
        model.tracker.marks = marks;
        model.tracker.partial = partial;
        Ok(model)
    }
}

fn take_part<'a>(input: &mut &'a [u8], cap: usize) -> Option<&'a [u8]> {
    let length = usize::try_from(take_u32(input)?).ok()?;
    if length > cap {
        return None;
    }
    take(input, length)
}
