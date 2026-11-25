//! Owner-selected OpenCode v1 listener for a configured remote executable.
//!
//! This is the only product provider with forwarding authority. The listener and
//! the single `-L` come from the owner (`Startup::reserve` and a private socket);
//! the request contributes only the authorized workspace.

use super::{Outcome, POLL, STOP_GRACE, finish_bridge, finish_socket, unavailable};
use crate::{
    owner_opencode_v1::control::{Control, Receipt},
    owner_opencode_v1::local::{ForwardSocket, SshChild},
    transport::PinnedSsh,
    v1::{ErrorCode, ProviderServiceScope},
};
use bigbud_ssh_owner::opencode_v1::{Bridge, REMOTE_ENDPOINT, Startup, StartupError};
use std::path::Path;
use std::{io, thread, time::Duration, time::Instant};

const HEARTBEAT: Duration = Duration::from_millis(500);
const MAX_PATH_BYTES: usize = 4095;
const LIMIT: u64 = 128 * 1024 * 1024;

const LAUNCH: &str = concat!(
    r#"
[[ $# == 8 ]] || exit 126
binary=$1 cwd=$2 limit=$3 nonce=$4 host=$5 port=$6 supervisor=$7 mode=$8
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
"#,
    include_str!("../owner_agent_proxy/provider_service_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
[[ -x /usr/bin/python3 ]] || exit 126
unset PWD OLDPWD
exec /usr/bin/python3 -I -c "$supervisor" "$cwd" "$nonce" "$host" "$port" "$mode"
"#,
);

pub(crate) struct ProductRecipe {
    binary: String,
    root: String,
}

impl ProductRecipe {
    pub(crate) fn new(binary: &Path, root: &Path) -> io::Result<Self> {
        let binary = exact_path(binary)?;
        let root = exact_path(root)?;
        if root == "/" || binary == root {
            return Err(invalid_scope());
        }
        Ok(Self {
            binary: binary.to_owned(),
            root: root.to_owned(),
        })
    }

    pub(crate) fn matches(&self, scope: &ProviderServiceScope) -> bool {
        scope.cwd == self.root
            && !scope.thread_id.is_empty()
            && scope.thread_id.len() <= 128
            && scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    pub(crate) fn run(
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
        let Ok(nonce) = crate::random_token() else {
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
            "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin /bin/bash -o pipefail -c {} bigbud-opencode-service {} {} {LIMIT} {} {} {} {} product",
            quote(LAUNCH),
            quote(&self.binary),
            quote(&self.root),
            quote(nonce),
            REMOTE_ENDPOINT.ip(),
            REMOTE_ENDPOINT.port(),
            quote(include_str!("../owner_opencode_v1/supervise.py")),
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

fn exact_path(path: &Path) -> io::Result<&str> {
    let path = path.to_str().ok_or_else(invalid_scope)?;
    let rest = path.strip_prefix('/').ok_or_else(invalid_scope)?;
    if path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || rest.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(invalid_scope());
    }
    Ok(path)
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

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid OpenCode service binding",
    )
}
