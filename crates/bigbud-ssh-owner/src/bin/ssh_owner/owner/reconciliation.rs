//! Owner-initiated restart reconciliation (W3.7).
//!
//! A production owner asks the authenticated backend for its unresolved
//! retirement mirror and retained direct pane bindings before it accepts the
//! session. Every row is verified READ-ONLY with the same rules as the local
//! retirement journal: nothing is signalled, adopted, respawned or cleared, and
//! exit is never inferred from a free lock, a socket or an unverifiable row.
//!
//! A refusal is reported in `HelloAccepted` with a typed code and keeps owner
//! admission closed. A rebind rotates the round, so a previous acknowledgement
//! can never admit the new binding.

use super::retirement;
use crate::{
    RunResult, Token,
    owner_pipe::{PayloadPipe, protocol_error},
    random_token,
    v1::{ErrorCode, ProofReconcileHydrate, ProofReconcileSnapshot, frame::Payload},
};

mod pane;
mod retire;

#[cfg(test)]
#[path = "reconciliation.tests.rs"]
mod tests;

const DIGEST_BYTES: usize = 32;
const MAX_ENVELOPE: usize = 256;
pub(crate) const RETIREMENT: ErrorCode = ErrorCode::OwnerRetirementUnverified;
pub(crate) const PANE: ErrorCode = ErrorCode::PaneUnrecoverable;

/// The owner's verdict for one exact reconciliation round.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Ack {
    pub(crate) request_id: Vec<u8>,
    pub(crate) digest: Vec<u8>,
    pub(crate) retirements: u32,
    pub(crate) panes: u32,
    pub(crate) error: ErrorCode,
}

impl Ack {
    pub(crate) fn acknowledged(&self) -> bool {
        self.error == ErrorCode::Unspecified
    }
}

/// Asks the backend for the restart set and verifies it before returning.
pub(crate) fn reconcile(
    pipe: &mut impl PayloadPipe,
    epoch: &Token,
    generation: &[u8],
) -> RunResult<Ack> {
    let request_id = next_request_id()?;
    let owner_epoch = retirement::epoch_hex(epoch);
    pipe.send(Payload::ProofReconcileHydrate(ProofReconcileHydrate {
        request_id: request_id.clone(),
        // The hex token lets a pane journal compare the owner epoch as recorded.
        owner_epoch: owner_epoch.clone().into_bytes(),
        generation: generation.to_vec(),
    }))?;
    let Some(Payload::ProofReconcileSnapshot(snapshot)) = pipe.recv()? else {
        return Err(protocol_error().into());
    };
    verify(request_id, snapshot, &owner_epoch)
}

/// Verifies an already-received snapshot with the exact rules.
pub(crate) fn verify(
    request_id: Vec<u8>,
    snapshot: ProofReconcileSnapshot,
    owner_epoch: &str,
) -> RunResult<Ack> {
    if snapshot.request_id != request_id || snapshot.digest.len() != DIGEST_BYTES {
        return Err(protocol_error().into());
    }
    if snapshot.error != ErrorCode::Unspecified as i32 {
        // A failed read is typed and never mutates anything; the backend keeps
        // admission closed from `reconciliation_error`.
        return Ok(Ack {
            request_id,
            digest: snapshot.digest,
            retirements: 0,
            panes: 0,
            error: ErrorCode::StorageUnavailable,
        });
    }
    if snapshot.retirements.len() > MAX_ENVELOPE || snapshot.panes.len() > MAX_ENVELOPE {
        return Err(protocol_error().into());
    }
    let retirements = u32::try_from(snapshot.retirements.len()).map_err(|_| protocol_error())?;
    let panes = u32::try_from(snapshot.panes.len()).map_err(|_| protocol_error())?;
    let mut error = ErrorCode::Unspecified;
    for entry in &snapshot.retirements {
        if error == ErrorCode::Unspecified && retire::check(entry).is_err() {
            error = RETIREMENT;
        }
    }
    for binding in &snapshot.panes {
        if error == ErrorCode::Unspecified && pane::check(binding, owner_epoch).is_err() {
            error = PANE;
        }
    }
    Ok(Ack {
        request_id,
        digest: snapshot.digest,
        retirements,
        panes,
        error,
    })
}

/// How one retained pane was classified. Uncertain reservations stay retained.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Disposition {
    /// A live reservation: keep it, never spawn another.
    AttachOnly,
    /// Ownership is unprovable: retain it without closing or respawning.
    HostLost,
    /// Confirmed termination: the pane is closed, never reattached.
    Closed,
}

fn next_request_id() -> RunResult<Vec<u8>> {
    #[cfg(test)]
    if let Some(token) = test_request_id() {
        return Ok(token.to_vec());
    }
    Ok(random_token()?.to_vec())
}

// Test support only: a scripted pipe cannot know the random round id, so a
// test may pin the next one before `bootstrap`. Production always draws fresh.
#[cfg(test)]
thread_local! {
    static PINNED_REQUEST_ID: std::cell::Cell<Option<Token>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn pin_test_request_id(token: Token) {
    PINNED_REQUEST_ID.with(|slot| slot.set(Some(token)));
}

#[cfg(test)]
fn test_request_id() -> Option<Token> {
    PINNED_REQUEST_ID.with(std::cell::Cell::get)
}
