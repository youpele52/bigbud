use super::{ErrorCode, Transport, v1};
use crate::random_token;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_CHUNK_BYTES: usize = 48 * 1024;
const MAX_OPERATION_ID_BYTES: usize = 128;
const DRAFT_TTL: Duration = Duration::from_secs(30);
const LEASE_BYTES: usize = 40;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Lease {
    nonce: [u8; 32],
    serial: u64,
}

impl Lease {
    fn from_wire(bytes: &[u8]) -> Option<Self> {
        let (nonce, serial) = bytes.split_at_checked(32)?;
        Some(Self {
            nonce: nonce.try_into().ok()?,
            serial: u64::from_be_bytes(serial.try_into().ok()?),
        })
    }

    fn to_wire(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(LEASE_BYTES);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&self.serial.to_be_bytes());
        bytes
    }
}

struct Draft {
    operation_id: String,
    root: String,
    path: String,
    body_bytes: usize,
    bytes: Vec<u8>,
    lease: Lease,
    deadline: Instant,
}

#[derive(Default)]
struct Slot {
    serial: u64,
    draft: Option<Draft>,
}

/// One staged unguarded write per owner. The lock covers both the 512 KiB body
/// and the lease bookkeeping; no remote work happens while it is held.
pub(crate) struct Stage {
    slot: Mutex<Slot>,
}

impl Stage {
    pub(crate) fn new() -> Self {
        Self {
            slot: Mutex::new(Slot::default()),
        }
    }

    pub(super) fn begin(
        &self,
        binding: &v1::ProofWorkspaceWriteBinding,
    ) -> Result<Vec<u8>, ErrorCode> {
        let (root, path, body_bytes) = binding_operands(binding)?;
        let mut slot = self.slot.lock().map_err(|_| ErrorCode::OwnerUnavailable)?;
        expire(&mut slot, Instant::now());
        if slot.draft.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        let serial = slot
            .serial
            .checked_add(1)
            .ok_or(ErrorCode::OwnerUnavailable)?;
        slot.serial = serial;
        let nonce = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let lease = Lease { nonce, serial };
        slot.draft = Some(Draft {
            operation_id: binding.operation_id.clone(),
            root,
            path,
            body_bytes,
            bytes: Vec::with_capacity(body_bytes),
            lease,
            deadline: Instant::now() + DRAFT_TTL,
        });
        Ok(lease.to_wire())
    }

    pub(super) fn chunk(
        &self,
        binding: &v1::ProofWorkspaceWriteBinding,
        lease: &[u8],
        offset: usize,
        data: &[u8],
    ) -> Result<u32, ErrorCode> {
        let lease = Lease::from_wire(lease).ok_or(ErrorCode::InvalidOperands)?;
        let (root, path, _) = binding_operands(binding)?;
        let mut slot = self.slot.lock().map_err(|_| ErrorCode::OwnerUnavailable)?;
        expire(&mut slot, Instant::now());
        let draft = slot.draft.as_mut().ok_or(ErrorCode::OperationDenied)?;
        if draft.lease != lease
            || draft.root != root
            || draft.path != path
            || draft.operation_id != binding.operation_id
        {
            return Err(ErrorCode::OperationDenied);
        }
        if data.is_empty() || data.len() > MAX_CHUNK_BYTES {
            return Err(ErrorCode::InvalidOperands);
        }
        if offset != draft.bytes.len() {
            return Err(ErrorCode::InvalidOperands);
        }
        if data.len() > draft.body_bytes - offset {
            return Err(ErrorCode::InvalidOperands);
        }
        draft.bytes.extend_from_slice(data);
        u32::try_from(offset + data.len()).map_err(|_| ErrorCode::InvalidOperands)
    }

    pub(super) fn commit(
        &self,
        binding: &v1::ProofWorkspaceWriteBinding,
        lease: &[u8],
    ) -> Result<(String, String, Vec<u8>), ErrorCode> {
        let lease = Lease::from_wire(lease).ok_or(ErrorCode::InvalidOperands)?;
        let (root, path, _) = binding_operands(binding)?;
        let mut slot = self.slot.lock().map_err(|_| ErrorCode::OwnerUnavailable)?;
        expire(&mut slot, Instant::now());
        let draft = slot.draft.as_ref().ok_or(ErrorCode::OperationDenied)?;
        if draft.lease != lease
            || draft.root != root
            || draft.path != path
            || draft.operation_id != binding.operation_id
        {
            return Err(ErrorCode::OperationDenied);
        }
        let draft = slot.draft.take().ok_or(ErrorCode::OperationDenied)?;
        if draft.bytes.len() != draft.body_bytes {
            return Err(ErrorCode::InvalidOperands);
        }
        Ok((draft.root, draft.path, draft.bytes))
    }

    pub(super) fn abort(
        &self,
        binding: &v1::ProofWorkspaceWriteBinding,
        lease: &[u8],
    ) -> Result<(), ErrorCode> {
        let lease = Lease::from_wire(lease).ok_or(ErrorCode::InvalidOperands)?;
        let (root, path, _) = binding_operands(binding)?;
        let mut slot = self.slot.lock().map_err(|_| ErrorCode::OwnerUnavailable)?;
        expire(&mut slot, Instant::now());
        let draft = slot.draft.as_ref().ok_or(ErrorCode::OperationDenied)?;
        if draft.lease != lease
            || draft.root != root
            || draft.path != path
            || draft.operation_id != binding.operation_id
        {
            return Err(ErrorCode::OperationDenied);
        }
        slot.draft = None;
        Ok(())
    }
}

fn binding_operands(
    binding: &v1::ProofWorkspaceWriteBinding,
) -> Result<(String, String, usize), ErrorCode> {
    let body_bytes = binding.body_bytes.ok_or(ErrorCode::InvalidOperands)?;
    let body_bytes = usize::try_from(body_bytes).map_err(|_| ErrorCode::InvalidOperands)?;
    if body_bytes > MAX_BODY_BYTES
        || binding.operation_id.is_empty()
        || binding.operation_id.len() > MAX_OPERATION_ID_BYTES
        || binding.operation_id.contains('\0')
    {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok((
        binding.workspace_root.clone(),
        binding.relative_path.clone(),
        body_bytes,
    ))
}

fn expire(slot: &mut Slot, now: Instant) {
    if slot
        .draft
        .as_ref()
        .is_some_and(|draft| now >= draft.deadline)
    {
        slot.draft = None;
    }
}

impl Transport {
    pub(crate) fn begin_workspace_write(
        &self,
        operand: &v1::ProofWorkspaceWriteBegin,
    ) -> Result<v1::ProofWorkspaceWriteStage, ErrorCode> {
        use v1::proof_workspace_write_stage::Outcome;
        let binding = operand.binding.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        super::validate_path(
            self.config.workspace_root.as_deref(),
            &binding.workspace_root,
            &binding.relative_path,
            false,
        )?;
        let begun = self.workspace_write_stage.begin(binding)?;
        Ok(stage(Outcome::Begun(begun)))
    }

    pub(crate) fn chunk_workspace_write(
        &self,
        operand: &v1::ProofWorkspaceWriteChunk,
    ) -> Result<v1::ProofWorkspaceWriteStage, ErrorCode> {
        use v1::proof_workspace_write_stage::Outcome;
        let binding = operand.binding.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        super::validate_path(
            self.config.workspace_root.as_deref(),
            &binding.workspace_root,
            &binding.relative_path,
            false,
        )?;
        let offset = usize::try_from(operand.offset).map_err(|_| ErrorCode::InvalidOperands)?;
        let next =
            self.workspace_write_stage
                .chunk(binding, &operand.lease, offset, &operand.data)?;
        Ok(stage(Outcome::ChunkAccepted(next)))
    }

    pub(crate) fn commit_workspace_write(
        &self,
        operand: &v1::ProofWorkspaceWriteCommit,
    ) -> Result<v1::ProofWorkspaceWriteStage, ErrorCode> {
        use v1::proof_workspace_write_stage::Outcome;
        let binding = operand.binding.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        let root = super::validate_path(
            self.config.workspace_root.as_deref(),
            &binding.workspace_root,
            &binding.relative_path,
            false,
        )?;
        let (_, path, contents) = self.workspace_write_stage.commit(binding, &operand.lease)?;
        super::write::write_bytes(self, root, &path, &contents)?;
        Ok(stage(Outcome::Written(v1::Empty {})))
    }

    pub(crate) fn abort_workspace_write(
        &self,
        operand: &v1::ProofWorkspaceWriteAbort,
    ) -> Result<v1::ProofWorkspaceWriteStage, ErrorCode> {
        use v1::proof_workspace_write_stage::Outcome;
        let binding = operand.binding.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        super::validate_path(
            self.config.workspace_root.as_deref(),
            &binding.workspace_root,
            &binding.relative_path,
            false,
        )?;
        self.workspace_write_stage.abort(binding, &operand.lease)?;
        Ok(stage(Outcome::Aborted(v1::Empty {})))
    }
}

fn stage(outcome: v1::proof_workspace_write_stage::Outcome) -> v1::ProofWorkspaceWriteStage {
    v1::ProofWorkspaceWriteStage {
        outcome: Some(outcome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(body_bytes: u32) -> v1::ProofWorkspaceWriteBinding {
        v1::ProofWorkspaceWriteBinding {
            operation_id: "op-1".into(),
            workspace_root: "/fixture/root".into(),
            relative_path: "a.txt".into(),
            body_bytes: Some(body_bytes),
        }
    }

    #[test]
    fn stages_exact_contiguous_bytes_and_consumes_the_lease() {
        let stage = Stage::new();
        let binding = binding(6);
        let lease = stage.begin(&binding).expect("begin");
        assert_eq!(stage.chunk(&binding, &lease, 0, b"abc").unwrap(), 3);
        assert_eq!(stage.chunk(&binding, &lease, 3, b"def").unwrap(), 6);
        let (root, path, bytes) = stage.commit(&binding, &lease).expect("commit");
        assert_eq!(
            (root.as_str(), path.as_str(), bytes.as_slice()),
            ("/fixture/root", "a.txt", b"abcdef".as_slice())
        );
        assert_eq!(
            stage.commit(&binding, &lease).unwrap_err(),
            ErrorCode::OperationDenied
        );
    }

    #[test]
    fn rejects_oversize_bodies_chunks_and_out_of_order_offsets() {
        let stage = Stage::new();
        assert_eq!(
            stage
                .begin(&binding(MAX_BODY_BYTES as u32 + 1))
                .unwrap_err(),
            ErrorCode::InvalidOperands
        );
        let binding = binding(4);
        let lease = stage.begin(&binding).expect("begin");
        assert_eq!(
            stage
                .chunk(&binding, &lease, 0, &vec![0; MAX_CHUNK_BYTES + 1])
                .unwrap_err(),
            ErrorCode::InvalidOperands
        );
        assert_eq!(
            stage.chunk(&binding, &lease, 1, b"ab").unwrap_err(),
            ErrorCode::InvalidOperands
        );
        assert_eq!(
            stage.chunk(&binding, &lease, 0, b"toolong").unwrap_err(),
            ErrorCode::InvalidOperands
        );
    }

    #[test]
    fn foreign_lease_or_binding_cannot_consume_another_draft() {
        let stage = Stage::new();
        let binding = binding(3);
        let lease = stage.begin(&binding).expect("begin");
        let other = Stage::new();
        let other_lease = other.begin(&binding).expect("other begin");
        assert_eq!(
            stage.chunk(&binding, &other_lease, 0, b"abc").unwrap_err(),
            ErrorCode::OperationDenied
        );
        let mut changed = binding.clone();
        changed.relative_path = "b.txt".into();
        assert_eq!(
            stage.chunk(&changed, &lease, 0, b"abc").unwrap_err(),
            ErrorCode::OperationDenied
        );
        stage.abort(&binding, &lease).expect("abort");
        assert_eq!(
            stage.commit(&binding, &lease).unwrap_err(),
            ErrorCode::OperationDenied
        );
    }

    #[test]
    fn rejects_missing_or_blank_binding_fields_before_staging() {
        let stage = Stage::new();
        let mut value = binding(3);
        value.body_bytes = None;
        assert_eq!(stage.begin(&value).unwrap_err(), ErrorCode::InvalidOperands);
        let mut value = binding(3);
        value.operation_id.clear();
        assert_eq!(stage.begin(&value).unwrap_err(), ErrorCode::InvalidOperands);
        let mut value = binding(3);
        value.operation_id = "x".repeat(MAX_OPERATION_ID_BYTES + 1);
        assert_eq!(stage.begin(&value).unwrap_err(), ErrorCode::InvalidOperands);
    }
}
