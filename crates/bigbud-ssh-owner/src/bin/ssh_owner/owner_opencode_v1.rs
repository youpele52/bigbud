//! Isolated Linux OpenCode v1 proof. Only this recipe has SSH forwarding authority.

#[path = "owner_opencode_v1/control.rs"]
mod control;
#[path = "owner_opencode_v1/local.rs"]
mod local;
#[path = "owner_opencode_v1/product.rs"]
mod product;
pub(super) use product::ProductRecipe;
#[cfg(test)]
#[path = "owner_opencode_v1/tests.rs"]
mod tests;

use super::{
    random_token,
    transport::PinnedSsh,
    v1::{ErrorCode, ProofProviderScope},
};
use bigbud_ssh_owner::opencode_v1::{Bridge, REMOTE_ENDPOINT, Startup, StartupError};
use control::{Control, Receipt};
use local::{ForwardSocket, SshChild};
use std::{
    io, thread,
    time::{Duration, Instant},
};

const FIXTURE_PREFIX: &str = "/tmp/bigbud-opencode-v1-";
const LIMIT: u64 = 128 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(5);
const HEARTBEAT: Duration = Duration::from_millis(500);
const STOP_GRACE: Duration = Duration::from_millis(900);

const LAUNCH: &str = concat!(
    r#"
[[ $# == 9 ]] || exit 126
binary=$1 expected=$2 cwd=$3 root=$4 limit=$5 nonce=$6 host=$7 port=$8 supervisor=$9
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
safe_home() { private_dir "$root"; }
"#,
    include_str!("owner_agent_proxy/provider_elf_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
[[ -x /usr/bin/python3 ]] || exit 126
umask 077
exec /usr/bin/python3 -I -c "$supervisor" "$root" "$nonce" "$host" "$port"
"#,
);

#[derive(Clone)]
pub(super) struct Recipe {
    scope: ProofProviderScope,
    command: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Rejected(ErrorCode),
    Exited(i32),
    Lost,
    Cancelled,
    Unconfirmed,
}

impl Recipe {
    pub(super) fn new(scope: ProofProviderScope, sha256: String) -> io::Result<Self> {
        let binary_root = fixture_root(&scope.binary).ok_or_else(invalid_scope)?;
        let cwd_root = fixture_root(&scope.cwd).ok_or_else(invalid_scope)?;
        if binary_root != cwd_root
            || scope.binary == scope.cwd
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            || scope.thread_id.is_empty()
            || scope.thread_id.len() > 128
            || !scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(invalid_scope());
        }
        let command = format!(
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-opencode-v1 {} {} {} {} {LIMIT}",
            quote(LAUNCH),
            quote(&scope.binary),
            quote(&sha256),
            quote(&scope.cwd),
            quote(cwd_root),
        );
        Ok(Self { scope, command })
    }

    pub(super) fn matches(&self, scope: &ProofProviderScope) -> bool {
        self.scope == *scope
    }

    pub(super) fn run(
        &self,
        pinned: PinnedSsh,
        host: &str,
        ready: impl FnOnce(u16) -> bool,
        cancelled: impl Fn() -> bool,
    ) -> Outcome {
        if cancelled() {
            return Outcome::Cancelled;
        }
        let Ok(mut startup) = Startup::reserve() else {
            return unavailable();
        };
        let Ok(nonce) = random_token() else {
            return unavailable();
        };
        let nonce = hex(&nonce);
        let command = self.remote_command(&nonce);
        let Ok(socket) = ForwardSocket::new() else {
            return unavailable();
        };
        let Ok(bridge) = Bridge::start(&startup, socket.path()) else {
            return finish_socket(socket, unavailable());
        };
        let outcome = if cancelled() {
            finish_bridge(bridge, Outcome::Cancelled)
        } else {
            match SshChild::spawn(pinned, host, &command, socket.path()) {
                Ok(mut ssh) => supervise(&mut ssh, bridge, &mut startup, &nonce, ready, cancelled),
                Err(_) => finish_bridge(bridge, unavailable()),
            }
        };
        drop(startup);
        finish_socket(socket, outcome)
    }

    fn remote_command(&self, nonce: &str) -> String {
        format!(
            "{} {} {} {} {}",
            self.command,
            quote(nonce),
            REMOTE_ENDPOINT.ip(),
            REMOTE_ENDPOINT.port(),
            quote(include_str!("owner_opencode_v1/supervise.py"))
        )
    }
}

fn supervise(
    ssh: &mut SshChild,
    bridge: Bridge,
    startup: &mut Startup,
    nonce: &str,
    ready: impl FnOnce(u16) -> bool,
    cancelled: impl Fn() -> bool,
) -> Outcome {
    if ssh.setup().is_err() {
        let outcome = finish_bridge(bridge, unavailable());
        return if ssh.kill_and_reap() {
            outcome
        } else {
            Outcome::Unconfirmed
        };
    }
    let mut control = Control::new(nonce);
    let mut on_ready = Some(ready);
    let mut heartbeat = Instant::now();
    let trigger = loop {
        if cancelled() {
            break Outcome::Cancelled;
        }
        if bridge.is_finished() {
            break Outcome::Lost;
        }
        let pre_ready = on_ready.is_some();
        if control
            .drain(ssh, pre_ready.then_some(&mut *startup))
            .is_err()
        {
            break if pre_ready {
                Outcome::Rejected(ErrorCode::TransportLost)
            } else {
                Outcome::Lost
            };
        }
        // Bound both preparation and the health probe by the same startup
        // deadline. Never publish based on evidence from a now-exited SSH child.
        let port = if pre_ready {
            match startup.poll_ready(&cancelled) {
                Ok(port) => port,
                Err(StartupError::Cancelled) => break Outcome::Cancelled,
                Err(_) => break Outcome::Rejected(ErrorCode::TransportLost),
            }
        } else {
            None
        };
        if port.is_some() && control.drain(ssh, None).is_err() {
            break Outcome::Rejected(ErrorCode::TransportLost);
        }
        match ssh.reaped() {
            Ok(false) if control.terminal().is_none() => {}
            Ok(_) if pre_ready => break Outcome::Rejected(ErrorCode::TransportLost),
            _ => break Outcome::Lost,
        }
        if cancelled() {
            break Outcome::Cancelled;
        }
        if bridge.is_finished() {
            break Outcome::Lost;
        }
        if let Some(port) = port
            && let Some(publish) = on_ready.take()
            && !publish(port)
        {
            break Outcome::Cancelled;
        }
        if control.prepared() && !control.launched() {
            match ssh.send(b'S') {
                Ok(true) => {
                    control.note_launch();
                    heartbeat = Instant::now() + HEARTBEAT;
                }
                Ok(false) => {}
                Err(_) => break Outcome::Lost,
            }
        } else if control.launched() && Instant::now() >= heartbeat {
            match ssh.send(b'H') {
                Ok(true) => heartbeat = Instant::now() + HEARTBEAT,
                Ok(false) => {}
                Err(_) => break Outcome::Lost,
            }
        }
        thread::sleep(POLL);
    };
    ssh.close_input();
    // Retire bridge admission and close every stream before reporting an outcome.
    let trigger = finish_bridge(bridge, trigger);
    let stop = Instant::now() + STOP_GRACE;
    let mut reaped = false;
    while Instant::now() < stop {
        let _drained = control.drain(ssh, None);
        match ssh.reaped() {
            Ok(true) => {
                reaped = true;
                break;
            }
            Ok(false) => thread::sleep(POLL),
            Err(_) => break,
        }
    }
    if !reaped && !ssh.kill_and_reap() {
        return Outcome::Unconfirmed;
    }
    // Once the local child is reaped, drain the bounded buffered suffix so
    // stderr noise cannot cause a genuine terminal receipt to be missed.
    for _ in 0..64 {
        if control.terminal().is_some() || !matches!(control.drain(ssh, None), Ok(true)) {
            break;
        }
    }
    settle(
        trigger,
        control.launched(),
        on_ready.is_none(),
        control.terminal(),
    )
}

fn settle(trigger: Outcome, launched: bool, ready: bool, receipt: Option<Receipt>) -> Outcome {
    match (trigger, launched, receipt) {
        (Outcome::Unconfirmed, _, _) => Outcome::Unconfirmed,
        (Outcome::Cancelled, true, None) => Outcome::Unconfirmed,
        (_, true, None) => Outcome::Lost,
        (Outcome::Lost, _, receipt) if ready => receipt
            .and_then(Receipt::exit_code)
            .map_or(Outcome::Lost, Outcome::Exited),
        (outcome, _, _) => outcome,
    }
}

fn finish_bridge(bridge: Bridge, outcome: Outcome) -> Outcome {
    if bridge.shutdown().is_ok() {
        outcome
    } else {
        Outcome::Unconfirmed
    }
}

fn finish_socket(socket: ForwardSocket, outcome: Outcome) -> Outcome {
    match socket.close() {
        Ok(()) => outcome,
        Err(_) => Outcome::Unconfirmed,
    }
}

fn unavailable() -> Outcome {
    Outcome::Rejected(ErrorCode::OwnerUnavailable)
}

fn fixture_root(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(FIXTURE_PREFIX)?;
    let (name, trailing) = rest.split_once('/')?;
    if path.len() > 4095
        || path.chars().any(char::is_control)
        || name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || trailing
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return None;
    }
    path.get(..FIXTURE_PREFIX.len() + name.len())
}

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid OpenCode v1 proof binding",
    )
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn hex(token: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(64);
    for byte in token {
        let _infallible = write!(result, "{byte:02x}");
    }
    result
}
