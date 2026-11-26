//! U15 production Git receive (push) lease worker.
//!
//! Same socket, path authority and pinned channel as `owner_git_upload`, but
//! the owner conducts the exchange instead of piping bytes. It reads the live
//! receive-pack advertisement, settles `Stale` unless the destination is at the
//! approved old OID, gives local Git a single-ref advertisement, admits exactly
//! the approved command through the receive gate, then pumps the pack and
//! forwards only a confirmed report. Anything uncertain after the command was
//! forwarded is `Unconfirmed` and is never replayed.

use crate::owner_git_upload::{self, Unaccepted, kill_group, quote};
use crate::owner_opencode::ForwardSocket;
use crate::transport::PinnedSsh;
use crate::v1::ErrorCode;
use bigbud_ssh_owner::git_receive_gate::{
    AdvertisedReceive, ApprovedTrackedUpdate, DestinationReceipt, TrackedReceiveError,
    bind_advertised,
};
use std::{
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::unix::{net::UnixStream, process::CommandExt},
    process::{Child, ChildStdin, ChildStdout, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[path = "owner_git_receive/pump.rs"]
mod pump;

/// Hard cap for one push, from the accepted connection.
const STREAM_DEADLINE: Duration = Duration::from_secs(120);
/// receive-pack may run hooks after its report; then the group is killed.
const EXIT_GRACE: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(5);
const GUARD_REFUSED: [i32; 2] = [125, 126];
const GUARD: &str = include_str!("owner_git_receive/guard.sh");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Receipt {
    Accepted,
    Unchanged,
    Rejected,
    Stale,
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Finished(Receipt),
    Rejected(ErrorCode),
    /// Closed or cancelled before any update was forwarded.
    Cancelled,
    /// Transport failure before any update was forwarded.
    Lost,
    Unconfirmed,
}

/// The owner-validated update this lease may forward.
#[derive(Clone, Debug)]
pub(crate) struct Approval {
    pub(crate) destination_ref: String,
    pub(crate) expected_old_oid: String,
    pub(crate) source_oid: String,
}

impl Approval {
    fn gate(&self) -> ApprovedTrackedUpdate<'_> {
        ApprovedTrackedUpdate {
            destination_ref: &self.destination_ref,
            advertised_old_oid: &self.expected_old_oid,
            approved_source_oid: &self.source_oid,
        }
    }

    /// Valid branch ref and two nonzero lowercase OIDs of one width, or a first
    /// publish: an all-zero old OID (the ref must then be absent on the target).
    pub(crate) fn is_valid(&self) -> bool {
        let gate = self.gate();
        gate.validate().is_ok() || gate.validate_creation().is_ok()
    }
}

pub(crate) fn remote_command(workspace_root: &str, repository_path: &str) -> String {
    format!(
        "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 \
         GIT_CONFIG_GLOBAL=/dev/null /bin/sh -c {} bigbud-git-receive {} {}",
        quote(GUARD),
        quote(workspace_root),
        quote(repository_path),
    )
}

/// What the conductor established, before the child's exit is known.
enum Conducted {
    Settled(Receipt),
    /// No update reached receive-pack.
    NotForwarded,
    Unconfirmed,
}

/// Accept one connection, conduct one push on it, and settle.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    mut pinned: PinnedSsh,
    host: &str,
    command: &str,
    socket: ForwardSocket,
    listener: std::os::unix::net::UnixListener,
    approval: &Approval,
    cancelled: impl Fn() -> bool + Sync,
    streaming: impl FnOnce(),
) -> Outcome {
    let (stream, socket_outcome) = match owner_git_upload::accept_once(socket, listener, &cancelled)
    {
        Ok(accepted) => accepted,
        Err(Unaccepted::Cancelled) => return Outcome::Cancelled,
        Err(Unaccepted::Lost) => return Outcome::Lost,
        Err(Unaccepted::Unconfirmed) => return Outcome::Unconfirmed,
    };
    let Ok(watch) = stream.try_clone() else {
        return Outcome::Lost;
    };
    let spawned = pinned
        .command
        .args(["--", host, command])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    let Ok(mut child) = spawned else {
        return Outcome::Rejected(ErrorCode::OwnerUnavailable);
    };
    let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
        return settle_killed(&mut child, Outcome::Lost);
    };
    streaming();
    let deadline = Instant::now() + STREAM_DEADLINE;
    let (done, fired) = (AtomicBool::new(false), AtomicBool::new(false));
    let pid = i32::try_from(child.id()).ok().filter(|&pid| pid > 0);
    let conducted = thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Acquire) {
                if cancelled() || Instant::now() >= deadline {
                    fired.store(true, Ordering::Release);
                    // SAFETY: process_group(0) made the child its group leader;
                    // it is not reaped before this scope ends.
                    if let Some(pid) = pid {
                        let _signalled = unsafe { libc::kill(-pid, libc::SIGKILL) };
                    }
                    let _shutdown = watch.shutdown(Shutdown::Both);
                    return;
                }
                thread::sleep(POLL);
            }
        });
        let revalidate = || !cancelled() && Instant::now() < deadline;
        let conducted = conduct(output, input, &stream, approval, revalidate);
        done.store(true, Ordering::Release);
        conducted
    });
    drop(pinned);
    let outcome = match conducted {
        Conducted::Settled(receipt) => Outcome::Finished(receipt),
        Conducted::Unconfirmed => Outcome::Unconfirmed,
        Conducted::NotForwarded if fired.load(Ordering::Acquire) => Outcome::Cancelled,
        Conducted::NotForwarded => Outcome::Lost,
    };
    let outcome = match (wait(&mut child, &cancelled), outcome) {
        (Some(code), Outcome::Lost) if GUARD_REFUSED.contains(&code) => {
            Outcome::Rejected(ErrorCode::OperationDenied)
        }
        (_, outcome) => outcome,
    };
    match (socket_outcome, outcome) {
        (Ok(()), outcome) | (Err(_), outcome @ Outcome::Finished(_)) => outcome,
        (Err(_), _) => Outcome::Unconfirmed,
    }
}

fn conduct(
    output: ChildStdout,
    input: ChildStdin,
    client: &UnixStream,
    approval: &Approval,
    revalidate: impl FnOnce() -> bool,
) -> Conducted {
    let mut writer = client;
    let bound = match bind_advertised(output, input, approval.gate()) {
        Ok(AdvertisedReceive::Update(bound)) => bound,
        Ok(AdvertisedReceive::Unchanged(advertisement)) => {
            // Local Git sees an up-to-date ref and answers with a flush.
            if writer.write_all(&advertisement).is_ok() {
                let mut reader = client;
                let _client_flush = reader.read_exact(&mut [0; 4]);
            }
            return Conducted::Settled(Receipt::Unchanged);
        }
        Err(TrackedReceiveError::StaleRef) => return Conducted::Settled(Receipt::Stale),
        Err(_) => return Conducted::NotForwarded,
    };
    if writer.write_all(bound.advertisement()).is_err() {
        return Conducted::NotForwarded;
    }
    let mut reader = client;
    let forwarded = match bound.forward_prefix(&mut reader, revalidate) {
        Ok(forwarded) => forwarded,
        Err(TrackedReceiveError::Gate(_)) => return Conducted::Settled(Receipt::Refused),
        Err(TrackedReceiveError::UnconfirmedForward(_)) => return Conducted::Unconfirmed,
        Err(_) => return Conducted::NotForwarded,
    };
    let (receipt, wire) = forwarded.exchange_pack(|remote_output, remote_input, limit| {
        pump::exchange(client, remote_output, remote_input, limit)
    });
    let receipt = match receipt {
        DestinationReceipt::Accepted => Receipt::Accepted,
        DestinationReceipt::Rejected => Receipt::Rejected,
        DestinationReceipt::Unchanged | DestinationReceipt::Unconfirmed => {
            return Conducted::Unconfirmed;
        }
    };
    // A local failure cannot undo a confirmed receipt.
    let _local_notification = writer.write_all(&wire);
    let _local_close = client.shutdown(Shutdown::Write);
    Conducted::Settled(receipt)
}

/// The child's exit code within the grace; on cancellation or after the grace
/// its group is killed so a close settles within the lease's budget.
fn wait(child: &mut Child, cancelled: &impl Fn() -> bool) -> Option<i32> {
    let deadline = Instant::now() + EXIT_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline && !cancelled() => thread::sleep(POLL),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            _ => {
                let _reaped = kill_group(child);
                return None;
            }
        }
    }
}

fn settle_killed(child: &mut Child, outcome: Outcome) -> Outcome {
    if kill_group(child) {
        outcome
    } else {
        Outcome::Unconfirmed
    }
}

#[cfg(test)]
#[path = "owner_git_receive/tests.rs"]
mod tests;
