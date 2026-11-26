//! C15 / W2 T-xfer: reserved transfer boundary fixture.
//!
//! **This is not a transfer engine.** There is no recursive traversal, no rsync
//! packaging, no throughput path and no publication here. Those start only
//! after S4 is accepted and transfer M0 begins.
//!
//! The two reserved verbs (`proof_transfer_stream` -> `transfer_stream` and
//! `proof_packaged_rsync` -> `packaged_rsync`) are declared on the wire and
//! denied typed by `Owner::execute`. This module is compiled under `cfg(test)`
//! and is the disposable fixture that proves the boundary:
//!
//! - [`StreamFixture`] opens a scoped duplex between this native process and a
//!   supervised native child over an owner-held `UnixStream`. Credits are
//!   bounded, half-close is write-only, cancel binds the exact lease, and the
//!   exit is reported once. Content bytes never enter a control message.
//! - [`SupervisedChild`] launches one fixed local child recipe with an
//!   owner-selected `-e` executable, argv and environment. The worker supplies
//!   validated operands only; a caller-supplied executable, argv, env or SSH
//!   option is refused typed, and the child tree is charged to one transfer
//!   lease.
//!
//! Every entry point consumes a [`TransferGrant`], so a PTY, thread-shell, peer
//! or ordinary-trust grant can never satisfy a transfer.

use std::time::Duration;

use crate::v1::{
    ErrorCode, ProofTransferAuthMode, ProofTransferLaunchAttempt, ProofTransferOperands,
    ProofTransferScope,
};

#[path = "transfer_fixture.stream.rs"]
mod stream;

#[path = "transfer_fixture.child.rs"]
mod child;

#[cfg(test)]
#[path = "transfer_fixture.tests.rs"]
mod tests;

/// Owner-issued opaque transfer id. Same width as every owner token.
pub(super) const TRANSFER_ID_BYTES: usize = 32;
pub(super) const MAX_OPERAND_TEXT: usize = 4096;
pub(super) const MAX_TRANSFER_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_ENTRIES: u32 = 64;
/// Outstanding credit window per stream, never above this.
pub(super) const MAX_CREDITS: u64 = 64 * 1024;
pub(super) const CHANNEL_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const REAP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransferVerb {
    Stream,
    PackagedRsync,
}

/// The roles a grant can be presented for. A transfer grant must never satisfy
/// a non-transfer role, and no other grant satisfies a transfer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GrantRole {
    Transfer(TransferVerb),
    Pty,
    ThreadShell,
    Peer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransferAuthority {
    PackagedKey,
    NativeChannel,
}

impl TransferAuthority {
    fn from_wire(mode: i32) -> Result<Self, ErrorCode> {
        match ProofTransferAuthMode::try_from(mode) {
            Ok(ProofTransferAuthMode::PackagedKey) => Ok(Self::PackagedKey),
            Ok(ProofTransferAuthMode::NativeChannel) => Ok(Self::NativeChannel),
            // Unspecified, ordinary host trust and unknown values are all typed
            // refusals. Ordinary trust never authorizes a transfer.
            Ok(ProofTransferAuthMode::Unspecified | ProofTransferAuthMode::OrdinaryTrust)
            | Err(_) => Err(ErrorCode::OperationDenied),
        }
    }
}

/// One validated, bounded operand pair. The worker can never widen a bound.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TransferOperands {
    pub(super) source: String,
    pub(super) destination: String,
    pub(super) max_bytes: u64,
    pub(super) max_entries: u32,
}

/// The owner-issued authorization for exactly one transfer verb. It binds the
/// transfer id, target, generation and authority; it is single-use and it is
/// not a trust approval.
pub(super) struct TransferGrant {
    transfer_id: [u8; TRANSFER_ID_BYTES],
    target: String,
    generation: Vec<u8>,
    verb: TransferVerb,
    authority: TransferAuthority,
    consumed: bool,
}

impl TransferGrant {
    /// Bind a worker-echoed scope to the owner's current target and generation.
    pub(super) fn issue(
        target: &str,
        generation: &[u8],
        verb: TransferVerb,
        scope: &ProofTransferScope,
    ) -> Result<Self, ErrorCode> {
        if scope.transfer_id.len() != TRANSFER_ID_BYTES
            || scope.target_id != target
            || scope.target_generation != generation
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let authority = TransferAuthority::from_wire(scope.auth_mode)?;
        let mut transfer_id = [0; TRANSFER_ID_BYTES];
        transfer_id.copy_from_slice(&scope.transfer_id);
        Ok(Self {
            transfer_id,
            target: scope.target_id.clone(),
            generation: generation.to_vec(),
            verb,
            authority,
            consumed: false,
        })
    }

    pub(super) const fn authority(&self) -> TransferAuthority {
        self.authority
    }

    pub(super) const fn transfer_id(&self) -> [u8; TRANSFER_ID_BYTES] {
        self.transfer_id
    }

    #[cfg(test)]
    pub(super) fn target(&self) -> (&str, &[u8]) {
        (&self.target, &self.generation)
    }

    /// Consume the grant for exactly one verb. A replay, a different transfer
    /// verb or a different role is refused typed.
    pub(super) fn enter(&mut self, verb: TransferVerb) -> Result<(), ErrorCode> {
        if self.consumed || self.verb != verb {
            return Err(ErrorCode::OperationDenied);
        }
        self.consumed = true;
        Ok(())
    }

    /// Check whether this grant can be presented for `role`. Used by tests to
    /// prove transfer/PTY/shell/peer separation before any resource exists.
    #[cfg(test)]
    pub(super) fn authorize_role(&self, role: GrantRole) -> Result<(), ErrorCode> {
        match role {
            GrantRole::Transfer(verb) if verb == self.verb => Ok(()),
            _ => Err(ErrorCode::OperationDenied),
        }
    }
}

pub(super) fn validate_operands(
    wire: &ProofTransferOperands,
) -> Result<TransferOperands, ErrorCode> {
    if !relative_operand(&wire.source)
        || !relative_operand(&wire.destination)
        || wire.max_bytes == 0
        || wire.max_bytes > MAX_TRANSFER_BYTES
        || wire.max_entries == 0
        || wire.max_entries > MAX_ENTRIES
    {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(TransferOperands {
        source: wire.source.clone(),
        destination: wire.destination.clone(),
        max_bytes: wire.max_bytes,
        max_entries: wire.max_entries,
    })
}

/// A bounded, traversal-free relative operand. No absolute path, home shortcut,
/// glob, brace, shell metacharacter or control character is representable.
fn relative_operand(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERAND_TEXT
        && !value.starts_with('/')
        && !value.starts_with('~')
        && !value.starts_with('-')
        && !value.contains('\\')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LaunchField {
    Executable,
    Argv,
    Env,
    SshOption,
}

/// A caller-supplied launch attempt. The owner always compiles the real program,
/// argv, environment and `-e` command; anything here is a typed refusal.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct LaunchAttempt {
    pub(super) executable: String,
    pub(super) argv: Vec<String>,
    pub(super) env: Vec<String>,
    pub(super) ssh_option: String,
}

impl LaunchAttempt {
    pub(super) fn from_wire(wire: &ProofTransferLaunchAttempt) -> Self {
        Self {
            executable: wire.executable.clone(),
            argv: wire.argv.clone(),
            env: wire.env.clone(),
            ssh_option: wire.ssh_option.clone(),
        }
    }

    /// The first non-empty escape-hatch field, in a stable order.
    pub(super) fn refused_field(&self) -> Option<LaunchField> {
        if !self.executable.is_empty() {
            return Some(LaunchField::Executable);
        }
        if self.argv.iter().any(|argument| !argument.is_empty()) {
            return Some(LaunchField::Argv);
        }
        if self.env.iter().any(|entry| !entry.is_empty()) {
            return Some(LaunchField::Env);
        }
        (!self.ssh_option.is_empty()).then_some(LaunchField::SshOption)
    }
}

pub(super) fn validate_launch(attempt: &LaunchAttempt) -> Result<(), ErrorCode> {
    match attempt.refused_field() {
        None => Ok(()),
        // Every escape-hatch field is refused typed, before any resource exists.
        Some(_) => Err(ErrorCode::InvalidOperands),
    }
}
