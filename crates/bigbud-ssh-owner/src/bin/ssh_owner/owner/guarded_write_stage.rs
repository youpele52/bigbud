// In-memory fixture only. The future owner adapter must admit the operation and
// its digest-bound grant before begin, and handle replay through its ledger.
// This state neither authorizes paths on disk nor performs any remote work.

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_CHUNK_BYTES: usize = 48 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_OPERATION_ID_BYTES: usize = 128;
const DRAFT_TTL: Duration = Duration::from_secs(30);

type Token = [u8; 32];
type Sha256Bytes = [u8; 32];

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Binding {
    pub(crate) generation: Token,
    pub(crate) operation_id: String,
    pub(crate) root: String,
    pub(crate) path: String,
    pub(crate) expected_sha256: Sha256Bytes,
    pub(crate) attempted_sha256: Sha256Bytes,
    pub(crate) body_bytes: usize,
}

// No Debug output. Only the private proof lane accepts this opaque token.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Lease {
    nonce: Token,
    serial: u64,
}

impl Lease {
    pub(crate) fn from_wire(bytes: &[u8]) -> Option<Self> {
        let (nonce, serial) = bytes.split_at_checked(32)?;
        Some(Self {
            nonce: nonce.try_into().ok()?,
            serial: u64::from_be_bytes(serial.try_into().ok()?),
        })
    }

    pub(crate) fn to_wire(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(40);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&self.serial.to_be_bytes());
        bytes
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StageError {
    BindingMismatch,
    InvalidOperands,
    Busy,
    NoDraft,
    LeaseMismatch,
    InvalidChunkSize,
    InvalidOffset,
    SizeMismatch,
    DigestMismatch,
    InvalidText,
    LeaseUnavailable,
}

pub(crate) struct Committed {
    pub(crate) binding: Binding,
    pub(crate) bytes: Vec<u8>,
}

struct Draft {
    binding: Binding,
    lease: Lease,
    deadline: Instant,
    bytes: Vec<u8>,
}

/// One slot per owner. Deadlines are absolute, not renewed by chunks.
pub(crate) struct Stage {
    generation: Token,
    fixture_root: String,
    serial: u64,
    draft: Option<Draft>,
}

impl Stage {
    pub(crate) fn new(generation: Token, fixture_root: &str) -> Result<Self, StageError> {
        if !fixture_root
            .strip_prefix('/')
            .is_some_and(normal_components)
        {
            return Err(StageError::InvalidOperands);
        }
        Ok(Self {
            generation,
            fixture_root: fixture_root.into(),
            serial: 0,
            draft: None,
        })
    }

    /// `nonce` comes from the trusted caller, not from the request. An owner
    /// adapter would mint it with its existing secure token generator.
    pub(crate) fn begin(
        &mut self,
        binding: &Binding,
        nonce: Token,
        now: Instant,
    ) -> Result<Lease, StageError> {
        self.expire(now);
        if binding.generation != self.generation || binding.root != self.fixture_root {
            return Err(StageError::BindingMismatch);
        }
        if binding.body_bytes > MAX_BODY_BYTES
            || binding.operation_id.is_empty()
            || binding.operation_id.len() > MAX_OPERATION_ID_BYTES
            || binding.operation_id.contains('\0')
            || !valid_relative_path(&binding.path)
        {
            return Err(StageError::InvalidOperands);
        }
        if self.draft.is_some() {
            return Err(StageError::Busy);
        }
        let deadline = now
            .checked_add(DRAFT_TTL)
            .ok_or(StageError::LeaseUnavailable)?;
        let serial = self
            .serial
            .checked_add(1)
            .ok_or(StageError::LeaseUnavailable)?;
        let lease = Lease { nonce, serial };
        self.serial = serial;
        self.draft = Some(Draft {
            binding: binding.clone(),
            lease,
            deadline,
            bytes: Vec::with_capacity(binding.body_bytes),
        });
        Ok(lease)
    }

    pub(crate) fn chunk(
        &mut self,
        binding: &Binding,
        lease: Lease,
        offset: usize,
        bytes: &[u8],
        now: Instant,
    ) -> Result<(), StageError> {
        self.check(binding, lease, now)?;
        let draft = self.draft.as_mut().ok_or(StageError::NoDraft)?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(StageError::InvalidChunkSize);
        }
        if offset != draft.bytes.len() {
            return Err(StageError::InvalidOffset);
        }
        // The accumulated length never exceeds the declared body size.
        if bytes.len() > draft.binding.body_bytes - offset {
            return Err(StageError::SizeMismatch);
        }
        draft.bytes.extend_from_slice(bytes);
        Ok(())
    }

    /// A matching commit consumes the lease even if validation fails. A
    /// mismatched lease or binding never consumes another caller's draft.
    pub(crate) fn commit(
        &mut self,
        binding: &Binding,
        lease: Lease,
        now: Instant,
    ) -> Result<Committed, StageError> {
        self.check(binding, lease, now)?;
        let Draft { binding, bytes, .. } = self.draft.take().ok_or(StageError::NoDraft)?;
        if bytes.len() != binding.body_bytes {
            return Err(StageError::SizeMismatch);
        }
        let digest: Sha256Bytes = Sha256::digest(&bytes).into();
        if digest != binding.attempted_sha256 {
            return Err(StageError::DigestMismatch);
        }
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return Err(StageError::InvalidText);
        }
        Ok(Committed { binding, bytes })
    }

    pub(crate) fn abort(
        &mut self,
        binding: &Binding,
        lease: Lease,
        now: Instant,
    ) -> Result<(), StageError> {
        self.check(binding, lease, now)?;
        self.draft = None;
        Ok(())
    }

    /// Also available for an owner timer to release idle memory before the
    /// next request. The deadline itself is always checked on access.
    pub(crate) fn expire(&mut self, now: Instant) {
        if self
            .draft
            .as_ref()
            .is_some_and(|draft| now >= draft.deadline)
        {
            self.draft = None;
        }
    }

    /// Call before accepting requests after a generation change or reattach,
    /// including a reattach that keeps the same generation.
    pub(crate) fn reset_attachment(&mut self, generation: Token) {
        self.draft = None;
        self.generation = generation;
    }

    fn check(&mut self, binding: &Binding, lease: Lease, now: Instant) -> Result<(), StageError> {
        self.expire(now);
        let draft = self.draft.as_ref().ok_or(StageError::NoDraft)?;
        if draft.lease != lease {
            return Err(StageError::LeaseMismatch);
        }
        if &draft.binding != binding {
            return Err(StageError::BindingMismatch);
        }
        Ok(())
    }
}

fn normal_components(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && !path.contains('\0')
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn valid_relative_path(path: &str) -> bool {
    normal_components(path)
        && !path.starts_with('\\')
        && !matches!(path.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}
