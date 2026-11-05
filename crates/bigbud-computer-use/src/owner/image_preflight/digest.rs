//! SHA-256 of the RETAINED preflight image descriptor (never a reopened path),
//! via the workspace `sha2` hasher (one portable code path). A digest match
//! against an approved generation is content identity only, not
//! signature/ancestry/native-closure qualification.
use super::{ImagePreflight, candidate::retained_image};
use crate::native_fs::invalid;
use sha2::{Digest, Sha256};
use std::{io, os::fd::AsRawFd};

/// Conservative bound: larger candidates refuse rather than hash unboundedly.
pub(super) const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

impl ImagePreflight {
    /// Revalidates storage/shape, hashes exactly the retained inode by
    /// positional reads up to its recorded length, then revalidates again.
    pub fn sha256(&self) -> io::Result<[u8; 32]> {
        self.validate()?;
        let (file, length) = retained_image(self)?;
        if length > MAX_IMAGE_BYTES {
            return Err(invalid());
        }
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; CHUNK];
        let mut offset = 0_u64;
        while offset < length {
            let wanted =
                usize::try_from((length - offset).min(CHUNK as u64)).map_err(|_| invalid())?;
            let position = libc::off_t::try_from(offset).map_err(|_| invalid())?;
            // SAFETY: retained live descriptor; writable buffer of >= wanted
            // bytes; positional read leaves no shared cursor state behind.
            let read = unsafe {
                libc::pread(
                    file.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    wanted,
                    position,
                )
            };
            let read = match usize::try_from(read) {
                Ok(read) => read,
                Err(_) => {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
            };
            // A short/zero read means the inode changed under us.
            let bytes = buffer
                .get(..read)
                .filter(|_| read != 0)
                .ok_or_else(invalid)?;
            hasher.update(bytes);
            offset += read as u64;
        }
        let digest: [u8; 32] = hasher.finalize().into();
        self.validate()?;
        Ok(digest)
    }
}
