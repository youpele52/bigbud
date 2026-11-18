use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputReceipt {
    pub sequence: u64,
    pub sha256: [u8; 32],
    pub byte_length: usize,
    pub outcome: InputOutcome,
    pub writer_usable: bool,
}

/// One fixed-size receipt per writer, charged even before its first admission.
pub(super) struct ReceiptSlot(pub Option<InputReceipt>);
impl ReceiptSlot {
    pub(super) fn new() -> io::Result<Self> {
        if !reserve(&LEDGER_BYTES, ENTRY_COST) {
            return Err(io::Error::other("input receipt profile limit"));
        }
        Ok(Self(None))
    }
}
impl Drop for ReceiptSlot {
    fn drop(&mut self) {
        LEDGER_BYTES.fetch_sub(ENTRY_COST, Ordering::AcqRel);
    }
}

pub(super) fn payload_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"bigbud/pty-input/receipt-v1\0");
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
    hash.finalize().into()
}

pub(super) fn remember(ledger: &mut Ledger, sequence: u64, bytes: &[u8]) {
    // Admission is sequence-monotonic; old asynchronous completion cannot replace it.
    ledger.receipt.0 = Some(InputReceipt {
        sequence,
        sha256: payload_digest(bytes),
        byte_length: bytes.len(),
        outcome: InputOutcome::Accepted,
        writer_usable: false,
    });
}

pub(super) fn observe(ledger: &mut Ledger, sequence: u64, outcome: InputOutcome) {
    if let Some(receipt) = &mut ledger.receipt.0
        && receipt.sequence == sequence
    {
        receipt.outcome = outcome;
    }
}

impl InputWriter {
    /// Atomically observes an exact receipt OR retires the next never-admitted identity.
    /// No bytes are provided or written by this operation; ordinary submit uses this lock.
    pub fn reconcile(
        &self,
        sequence: u64,
        sha256: [u8; 32],
        byte_length: usize,
        allow_retire: bool,
    ) -> Result<InputReceipt, super::super::PtyError> {
        use super::super::PtyError;
        if sequence == 0
            || sequence > 9_007_199_254_740_991
            || byte_length > super::super::MAX_INPUT_BYTES
        {
            return Err(PtyError::InputLimit);
        }
        let mut ledger = self
            .shared
            .ledger
            .lock()
            .map_err(|_| super::super::poisoned())?;
        let usable = !ledger.fenced
            && !self.shared.cancelled.load(Ordering::Acquire)
            && !self.shared.finished.load(Ordering::Acquire);
        if let Some(mut receipt) = ledger.receipt.0
            && receipt.sequence == sequence
        {
            if receipt.sha256 != sha256 || receipt.byte_length != byte_length {
                return Err(PtyError::InputConflict);
            }
            receipt.writer_usable = usable;
            return Ok(receipt);
        }
        // Missing/expired older identities are never interpreted as zero delivery.
        if sequence <= ledger.high_water {
            return Err(PtyError::InputExpired);
        }
        let expected = ledger
            .high_water
            .checked_add(1)
            .ok_or(PtyError::InputExpired)?;
        if sequence != expected {
            return Err(PtyError::InputSequence {
                expected,
                actual: sequence,
            });
        }
        if !allow_retire || !usable || ledger.pending != 0 {
            return Err(PtyError::InputFenced);
        }
        prune(&mut ledger, Instant::now());
        compact_completed(&mut ledger);
        if ledger.records.len() >= 4096 || !reserve(&LEDGER_BYTES, ENTRY_COST) {
            return Err(PtyError::InputLimit);
        }
        let receipt = InputReceipt {
            sequence,
            sha256,
            byte_length,
            outcome: InputOutcome::NotAdmitted,
            writer_usable: true,
        };
        // Storage is reserved before publishing the tombstone and monotonic high water.
        // Its private digest is unused: submit refuses every tombstoned identity.
        ledger.records.insert(
            sequence,
            Record {
                digest: [0; 32],
                outcome: InputOutcome::NotAdmitted,
                completed: Some(Instant::now()),
            },
        );
        ledger.high_water = sequence;
        ledger.receipt.0 = Some(receipt);
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "input.reconcile.tests.rs"]
mod tests;
