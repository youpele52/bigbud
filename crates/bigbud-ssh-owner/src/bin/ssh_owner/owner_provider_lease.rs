//! W2 T-prov: production Pi and Codex provider lease recipe and worker.
//!
//! The owner compiles the whole remote command. The request contributes only
//! the provider kind, the authorized session and an exact remote cwd; the
//! executable is discovered on the target by an owner-shipped script and must
//! pass the shared provider executable guard (trusted directory chain, regular
//! single-link file, owner-only writable, size bound, ELF magic, opened
//! descriptor identity), and the opened descriptor is what runs.
//!
//! A lease's byte channel is two owner-created private Unix sockets (stdio and
//! stderr), each in its own `mkdtemp` 0700 directory and each admitting exactly
//! one connection within 15 s. Both paths are removed before the pinned SSH
//! child starts, so nothing can dial a second time. Unlike the Git upload
//! lease, a provider session has no stream deadline: it lives until the
//! provider exits, the caller closes it or its target is retired.

use crate::owner_opencode::ForwardSocket;
use crate::transport::PinnedSsh;
use crate::v1::{ErrorCode, ProviderLeaseKind, ProviderLeaseScope};
use std::{
    fs,
    io::{self, ErrorKind},
    os::{
        fd::OwnedFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_PATH_BYTES: usize = 1024;
/// Size ceiling for a discovered executable. Single-file provider builds (a
/// Bun-compiled Pi, a static Codex) are far larger than the proof fixture.
const LIMIT: u64 = 512 * 1024 * 1024;
/// The client must dial both sockets soon after the owner publishes them.
const ACCEPT_DEADLINE: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(5);
/// After close, a provider that already saw stdin EOF may exit on its own.
const TERM_GRACE: Duration = Duration::from_millis(750);
const KILL_GRACE: Duration = Duration::from_millis(500);
pub(crate) const RECEIPT_TAG: &str = "bigbud-provider-lease";

const LAUNCH: &str = concat!(
    r#"
[[ $# == 8 ]] || exit 126
provider=$1 cwd=$2 nonce=$3 limit=$4 action=$5 question=$6 resume=$7 codex_home=$8 binary=
configured= extra_candidates=
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
"#,
    include_str!("owner_agent_proxy/provider_service_guard.sh"),
    include_str!("owner_agent_proxy/provider_discovery.sh"),
    include_str!("transport/session_guard.sh"),
    include_str!("owner_provider_lease/launch.sh"),
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Pi,
    Codex,
}

impl Kind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Codex => "codex",
        }
    }

    /// Bounds for the `--version` probe: the Pi client deadline is 5 s, the
    /// Codex one 20 s, so the owner keeps headroom below each.
    pub(crate) fn probe_bounds(self) -> (Duration, usize) {
        match self {
            Self::Pi => (Duration::from_secs(4), 4096),
            Self::Codex => (Duration::from_secs(18), 1024 * 1024),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Exited(i32),
    Rejected(ErrorCode),
    Cancelled,
    Lost,
    Unconfirmed,
}

/// An absolute, normalized, control-free path of bounded length.
fn exact(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && path
            .strip_prefix('/')
            .is_some_and(|rest| !rest.split('/').any(|p| matches!(p, "" | "." | "..")))
        && !path.chars().any(char::is_control)
}

/// Owner-side operand checks. The remote guard re-checks the cwd after
/// resolving it (`cd -P`), so a symlinked or untrusted directory is refused
/// there before discovery runs.
pub(crate) fn admits(scope: &ProviderLeaseScope, probe: bool) -> Result<Kind, ErrorCode> {
    let kind = match ProviderLeaseKind::try_from(scope.kind) {
        Ok(ProviderLeaseKind::Pi) => Kind::Pi,
        Ok(ProviderLeaseKind::Codex) => Kind::Codex,
        _ => return Err(ErrorCode::InvalidOperands),
    };
    let thread = scope.thread_id.as_bytes();
    if !exact(&scope.cwd)
        || scope.cwd == "/"
        || thread.is_empty()
        || thread.len() > 128
        || !thread.iter().all(u8::is_ascii_graphic)
        || (scope.default_mode_user_input && (probe || kind == Kind::Pi))
        || (scope.session_file.is_some() && kind != Kind::Pi)
        || (scope.codex_home.is_some() && kind != Kind::Codex)
        || [&scope.session_file, &scope.codex_home]
            .into_iter()
            .flatten()
            .any(|path| !exact(path) || path == "/")
    {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(kind)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The complete remote command. Discovery and the executable guard run in a
/// fixed environment; the account's `HOME`, `SHELL`, `USER`, `LOGNAME` and
/// `LANG` are carried through, and the provider itself is exec'd through the
/// account's login shell (`sh -l`, U19), like the old path. The resume file
/// and Codex home are re-checked on the target (resolved, inside their roots).
pub(crate) fn remote_command(
    kind: Kind,
    scope: &ProviderLeaseScope,
    nonce: &str,
    start: bool,
) -> String {
    format!(
        "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" SHELL=\"$SHELL\" USER=\"$USER\" \
         LOGNAME=\"$LOGNAME\" LANG=\"$LANG\" PATH=/usr/bin:/bin \
         /bin/bash -o pipefail -c {} {RECEIPT_TAG} {} {} {} {LIMIT} {} {} {} {}",
        quote(LAUNCH),
        kind.name(),
        quote(&scope.cwd),
        quote(nonce),
        if start { "start" } else { "probe" },
        if start && scope.default_mode_user_input {
            "1"
        } else {
            "0"
        },
        quote(scope.session_file.as_deref().unwrap_or("")),
        quote(scope.codex_home.as_deref().unwrap_or("")),
    )
}

/// True when the remote side reported that no candidate passed the guard.
pub(crate) fn executable_missing(stderr: &[u8], nonce: &str) -> bool {
    let receipt = format!("{RECEIPT_TAG} {nonce} missing");
    String::from_utf8_lossy(stderr)
        .lines()
        .any(|line| line == receipt)
}

/// One lease socket: a private 0700 directory and a 0600 socket inside it.
pub(crate) struct Channel {
    socket: ForwardSocket,
    listener: UnixListener,
}

impl Channel {
    pub(crate) fn listen() -> io::Result<Self> {
        let socket = ForwardSocket::new()?;
        let listener = UnixListener::bind(socket.path())?;
        fs::set_permissions(socket.path(), fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self { socket, listener })
    }

    pub(crate) fn path(&self) -> Option<String> {
        self.socket.path().to_str().map(str::to_owned)
    }

    fn try_accept(&self) -> Result<Option<UnixStream>, ()> {
        match self.listener.accept() {
            Ok((stream, _)) => Ok(Some(stream)),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
                Ok(None)
            }
            Err(_) => Err(()),
        }
    }

    /// Removes the socket path and its directory; no second dial is possible.
    fn close(self) -> io::Result<()> {
        drop(self.listener);
        self.socket.close()
    }
}

fn close_all(channels: [Channel; 2], outcome: Outcome) -> Outcome {
    let [stdio, stderr] = channels;
    match (stdio.close(), stderr.close()) {
        (Ok(()), Ok(())) => outcome,
        _ => Outcome::Unconfirmed,
    }
}

/// Accept one connection on each channel, run the pinned child on them, and
/// settle. `running` fires once the child has been spawned.
pub(crate) fn run(
    mut pinned: PinnedSsh,
    host: &str,
    command: &str,
    channels: [Channel; 2],
    cancelled: impl Fn() -> bool,
    running: impl FnOnce(),
) -> Outcome {
    let deadline = Instant::now() + ACCEPT_DEADLINE;
    let mut accepted: [Option<UnixStream>; 2] = [None, None];
    while accepted.iter().any(Option::is_none) {
        if cancelled() {
            return close_all(channels, Outcome::Cancelled);
        }
        if Instant::now() >= deadline {
            return close_all(channels, Outcome::Lost);
        }
        for (slot, channel) in accepted.iter_mut().zip(channels.iter()) {
            if slot.is_none() {
                match channel.try_accept() {
                    Ok(stream) => *slot = stream,
                    Err(()) => return close_all(channels, Outcome::Lost),
                }
            }
        }
        if accepted.iter().any(Option::is_none) {
            thread::sleep(POLL);
        }
    }
    let closed = close_all(channels, Outcome::Cancelled) == Outcome::Cancelled;
    let [Some(stdio), Some(stderr)] = accepted else {
        return Outcome::Lost;
    };
    if [&stdio, &stderr]
        .iter()
        .any(|stream| stream.set_nonblocking(false).is_err())
    {
        return Outcome::Lost;
    }
    let Ok(input) = stdio.try_clone() else {
        return Outcome::Lost;
    };
    pinned.command.args(["--", host, command]);
    // The SSH client runs under the local owner-death guard: if this owner
    // dies, the whole process group goes with it (see `local_guard`).
    let Ok(local_guard::Guarded {
        command: mut guarded,
        reader,
        owner_alive: _owner_alive,
    }) = local_guard::wrap(&pinned.command)
    else {
        return Outcome::Rejected(ErrorCode::OwnerUnavailable);
    };
    let spawned = guarded
        .stdin(Stdio::from(OwnedFd::from(input)))
        .stdout(Stdio::from(OwnedFd::from(stdio)))
        .stderr(Stdio::from(OwnedFd::from(stderr)))
        .spawn();
    // The command still owns copies of the sockets; release them now so the
    // caller observes EOF as soon as the child exits.
    drop(guarded);
    drop(reader);
    let Ok(mut child) = spawned else {
        return Outcome::Rejected(ErrorCode::OwnerUnavailable);
    };
    running();
    let outcome = supervise(&mut child, cancelled);
    drop(pinned);
    if closed {
        outcome
    } else {
        Outcome::Unconfirmed
    }
}

fn supervise(child: &mut Child, cancelled: impl Fn() -> bool) -> Outcome {
    let mut grace: Option<Instant> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match (grace, status.code()) {
                    (Some(_), _) => Outcome::Cancelled,
                    // 255 is the SSH client's own failure, not a provider exit.
                    (None, Some(code)) if code != 255 => Outcome::Exited(code),
                    (None, _) => Outcome::Lost,
                };
            }
            Ok(None) => match grace {
                None if cancelled() => grace = Some(Instant::now() + TERM_GRACE),
                Some(until) if Instant::now() >= until => return kill(child, Outcome::Cancelled),
                _ => thread::sleep(POLL),
            },
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return kill(child, Outcome::Unconfirmed),
        }
    }
}

fn kill(child: &mut Child, outcome: Outcome) -> Outcome {
    let pid = i32::try_from(child.id()).ok().filter(|&pid| pid > 0);
    // SAFETY: process_group(0) made this child its group leader and it is unreaped.
    if !pid.is_some_and(|pid| unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }) {
        let _kill_requested = child.kill();
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return outcome;
        }
        thread::sleep(POLL);
    }
    Outcome::Unconfirmed
}

#[path = "owner_provider_lease/local_guard.rs"]
mod local_guard;
#[cfg(test)]
#[path = "owner_provider_lease/tests.rs"]
mod tests;
