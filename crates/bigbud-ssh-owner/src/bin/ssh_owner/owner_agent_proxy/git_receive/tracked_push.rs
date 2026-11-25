//! Isolated one-shot composition. Only the trusted fixture adapter may supply
//! the already-scoped initiating Git and pinned receive-pack pipes.

use bigbud_ssh_owner::git_receive_gate::{
    ApprovedTrackedUpdate, BoundTrackedReceive, DestinationReceipt, observe_unchanged,
};
use std::{
    cell::RefCell,
    fs::File,
    io::{self, Read, Write},
    time::{Duration, Instant},
};

#[path = "tracked_push.io.rs"]
mod pipe;
use pipe::{Budget, Pipe};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepositoryIdentity {
    pub(crate) worktree: String,
    pub(crate) git_dir: String,
    pub(crate) common_dir: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrackedDestination {
    pub(crate) effective_url: String,
    pub(crate) execution_target_id: String,
    pub(crate) target_generation: String,
    pub(crate) host: String,
    pub(crate) user: String,
    pub(crate) port: u16,
    pub(crate) repository_path: String,
    pub(crate) expected_old_oid: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrackedPushBinding {
    pub(crate) repository: RepositoryIdentity,
    pub(crate) remote_name: String,
    pub(crate) source_ref: String,
    pub(crate) destination_ref: String,
    pub(crate) source_oid: String,
    pub(crate) destination: TrackedDestination,
}

pub(crate) struct TrackedPushRequest {
    pub(crate) binding: TrackedPushBinding,
    pub(crate) timeout_ms: u32,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TrackedPushResult {
    DeniedBeforeDispatch,
    Finished(DestinationReceipt),
}

/// Implemented only by the isolated owner of this pipe graph. Methods other
/// than retire must not block; retirement and admission are serialized by
/// exclusive lease ownership.
pub(crate) trait PushLease {
    fn is_current(&mut self) -> bool;
    fn is_cancelled(&self) -> bool;
    fn retire(self, deadline: Instant, receipt: DestinationReceipt);
}

pub(crate) struct ActivePush<L: PushLease> {
    pub(crate) git_input: File,
    pub(crate) git_output: File,
    pub(crate) receive_output: File,
    pub(crate) receive_input: File,
    pub(crate) lease: L,
}

pub(crate) struct Connector {
    approved: Option<TrackedPushBinding>,
}

impl Connector {
    /// The supplied binding must originate with the trusted startup launcher.
    pub(crate) fn new(approved: TrackedPushBinding) -> io::Result<Self> {
        if !valid_binding(&approved) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid isolated Git push binding",
            ));
        }
        Ok(Self {
            approved: Some(approved),
        })
    }

    /// Launch only after matching the entire approval. The trusted adapter
    /// must then revalidate live repository and target identities before
    /// opening the fixture graph. A launch error must leave no live graph.
    pub(crate) fn run<L: PushLease>(
        &mut self,
        request: &TrackedPushRequest,
        launch: impl FnOnce(&TrackedPushBinding, Instant) -> io::Result<ActivePush<L>>,
    ) -> TrackedPushResult {
        if !(1..=30_000).contains(&request.timeout_ms)
            || self.approved.as_ref() != Some(&request.binding)
        {
            return TrackedPushResult::DeniedBeforeDispatch;
        }
        let Some(approved) = self.approved.take() else {
            return TrackedPushResult::DeniedBeforeDispatch;
        };
        let deadline = Instant::now() + Duration::from_millis(u64::from(request.timeout_ms));
        let Ok(active) = launch(&approved, deadline) else {
            return TrackedPushResult::DeniedBeforeDispatch;
        };
        let ActivePush {
            git_input,
            git_output,
            receive_output,
            receive_input,
            lease,
        } = active;
        let lease = RefCell::new(lease);
        let receipt = {
            let cancelled = || lease.borrow().is_cancelled();
            let budget = Budget::new(deadline, &cancelled);
            let current = || budget.check().is_ok() && lease.borrow_mut().is_current();
            let conduct = || {
                conduct(
                    Pipe::reader(git_input, &budget)?,
                    Pipe::writer(git_output, &budget)?,
                    Pipe::reader(receive_output, &budget)?,
                    Pipe::writer(receive_input, &budget)?,
                    approval(&approved, &approved.destination_ref),
                    current,
                )
            };
            match conduct() {
                Ok(receipt) => receipt,
                Err(_) => DestinationReceipt::Unconfirmed,
            }
        };
        lease.into_inner().retire(deadline, receipt);
        TrackedPushResult::Finished(receipt)
    }
}

fn conduct(
    mut git_input: Pipe<'_>,
    mut git_output: Pipe<'_>,
    receive_output: Pipe<'_>,
    receive_input: Pipe<'_>,
    approval: ApprovedTrackedUpdate<'_>,
    current: impl Fn() -> bool,
) -> io::Result<DestinationReceipt> {
    if approval.advertised_old_oid == approval.approved_source_oid {
        let advertisement = observe_unchanged(receive_output, approval).map_err(gate_error)?;
        if !current() {
            return Ok(DestinationReceipt::Unconfirmed);
        }
        drop(receive_input);
        // Let ordinary Git send its no-op flush before closing the local
        // channel. Bounded by the same deadline; no local byte is forwarded.
        // Local notification cannot change the verified unchanged observation.
        if git_output.write_all(&advertisement).is_ok() {
            let _local_flush = git_input.read_exact(&mut [0; 4]);
        }
        return Ok(DestinationReceipt::Unchanged);
    }
    let bound =
        BoundTrackedReceive::bind(receive_output, receive_input, approval).map_err(gate_error)?;
    git_output.write_all(bound.advertisement())?;
    let forwarded = bound
        .forward_prefix(&mut git_input, current)
        .map_err(gate_error)?;
    let (receipt, wire) =
        forwarded.exchange_pack(|output, input, cap| pipe::exchange(git_input, output, input, cap));
    if receipt != DestinationReceipt::Unconfirmed {
        // A local failure cannot undo a verified receive-pack receipt. Do not
        // interpret the subsequent Git or SSH exit as a different outcome.
        let _local_notification = git_output.write_all(&wire);
    }
    Ok(receipt)
}

fn gate_error(_: bigbud_ssh_owner::git_receive_gate::TrackedReceiveError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "isolated receive gate refused input",
    )
}

fn approval<'a>(binding: &'a TrackedPushBinding, reference: &'a str) -> ApprovedTrackedUpdate<'a> {
    ApprovedTrackedUpdate {
        destination_ref: reference,
        advertised_old_oid: &binding.destination.expected_old_oid,
        approved_source_oid: &binding.source_oid,
    }
}

fn valid_binding(binding: &TrackedPushBinding) -> bool {
    let identity = &binding.repository;
    let destination = &binding.destination;
    [&identity.worktree, &identity.git_dir, &identity.common_dir]
        .into_iter()
        .all(|path| super::exact_path(path))
        && !binding.remote_name.starts_with('-')
        && !binding.remote_name.is_empty()
        && binding.remote_name.len() <= 255
        && !binding.remote_name.chars().any(char::is_control)
        && approval(binding, &binding.source_ref).validate().is_ok()
        && approval(binding, &binding.destination_ref)
            .validate()
            .is_ok()
        && valid_destination(destination)
}

fn valid_destination(destination: &TrackedDestination) -> bool {
    let TrackedDestination {
        effective_url,
        execution_target_id,
        target_generation,
        host,
        user,
        port,
        repository_path,
        ..
    } = destination;
    if !execution_target_id.starts_with("ssh:")
        || execution_target_id.len() <= 4
        || execution_target_id.len() > 4096
        || execution_target_id.chars().any(char::is_control)
        || target_generation.len() != 64
        || !target_generation
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        || !host
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
        || !user
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
        || *port == 0
        || !super::exact_path(repository_path)
        || !repository_path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'.' | b'_'))
        || effective_url.len() > 4096
    {
        return false;
    }
    // Allow either spelling for default SSH port, but the gate still compares
    // approval and request byte-for-byte: one spelling never grants the other.
    *effective_url == format!("ssh://{user}@{host}:{port}{repository_path}")
        || (*port == 22 && *effective_url == format!("ssh://{user}@{host}{repository_path}"))
}

#[cfg(test)]
#[path = "tracked_push.tests.rs"]
mod tests;
