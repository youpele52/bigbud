use bigbud_protocol::{encode_frame, encoded_frame_length, v1};
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) static PROFILE_BYTES: AtomicUsize = AtomicUsize::new(0);
static ENCODERS: AtomicUsize = AtomicUsize::new(0);
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(in crate::supervisor) struct EncodedFrame {
    pub bytes: Vec<u8>,
    charge: usize,
}
impl EncodedFrame {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}
impl Drop for EncodedFrame {
    fn drop(&mut self) {
        drop(std::mem::take(&mut self.bytes));
        PROFILE_BYTES.fetch_sub(self.charge, Ordering::AcqRel);
    }
}
struct Encoder;
impl Drop for Encoder {
    fn drop(&mut self) {
        ENCODERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// All allocated encoded copies, including waiting replay/control frames and
/// handoff spools, retain the same profile charge until their buffer is dropped.
pub(in crate::supervisor) fn encode(frame: &v1::Frame, maximum: usize) -> io::Result<EncodedFrame> {
    let size = encoded_frame_length(frame, maximum).map_err(io::Error::other)?;
    ENCODERS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < 64).then_some(active + 1)
        })
        .map_err(|_| io::Error::other("encoder concurrency exhausted"))?;
    let _encoder = Encoder;
    PROFILE_BYTES
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
            used.checked_add(size).filter(|next| *next <= MAX_BYTES)
        })
        .map_err(|_| io::Error::other("encoded profile budget exhausted"))?;
    let mut encoded = EncodedFrame {
        bytes: Vec::new(),
        charge: size,
    };
    encoded.bytes = encode_frame(frame, maximum).map_err(io::Error::other)?;
    Ok(encoded)
}

#[cfg(test)]
#[path = "writer.budget.tests.rs"]
mod tests;
