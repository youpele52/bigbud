//! One lease supervisor shared by every owner-selected OpenCode transport.

use super::{
    Control, ForwardSocket, HEARTBEAT, Outcome, POLL, STOP_GRACE, SshChild, finish_bridge,
    finish_socket, unavailable,
};
use crate::transport::PinnedSsh;
use crate::v1::ErrorCode;
use bigbud_ssh_owner::opencode_v1::Bridge;
use std::net::{SocketAddrV4, TcpListener};
use std::{thread, time::Instant};

/// Owner-verified readiness. `secret` is present only for a transport whose
/// server requires an owner-generated credential (OpenCode v2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadyPort {
    pub(crate) port: u16,
    pub(crate) secret: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadyFailure {
    Cancelled,
    Rejected,
}

/// The transport-specific part of a lease: a reserved local listener plus the
/// bounded readiness evidence the supervisor feeds it.
pub(crate) trait Ready {
    /// The retained local loopback reservation; the bridge never rebinds it.
    fn listener(&self) -> &TcpListener;

    /// Feed child stdout. Only a transport's exact readiness evidence may
    /// settle successfully; everything else is charged to the output cap.
    fn stdout(&mut self, bytes: &[u8]) -> Result<(), ()>;

    fn stderr(&mut self, bytes: &[u8]) -> Result<(), ()>;

    fn poll(&mut self, cancelled: &dyn Fn() -> bool) -> Result<Option<ReadyPort>, ReadyFailure>;

    /// Bytes the supervisor must write immediately after the launch signal.
    /// The v2 credential travels here, never in argv or in the environment of
    /// the receipt-printing supervisor.
    fn launch_secret(&self) -> Option<&str> {
        None
    }
}

/// Creates the private socket and bridge, runs the pinned child, and confirms
/// teardown. `publish` receives the first ready result exactly once.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    pinned: PinnedSsh,
    host: &str,
    command: &str,
    remote: SocketAddrV4,
    worker: &str,
    receipt_tag: &str,
    nonce: &str,
    ready: &mut dyn Ready,
    publish: impl FnOnce(ReadyPort) -> bool,
    cancelled: &dyn Fn() -> bool,
) -> Outcome {
    if cancelled() {
        return Outcome::Cancelled;
    }
    let Ok(socket) = ForwardSocket::new() else {
        return unavailable();
    };
    let Ok(bridge) = Bridge::start_listener(ready.listener(), socket.path()) else {
        return finish_socket(socket, unavailable());
    };
    let outcome = if cancelled() {
        finish_bridge(bridge, Outcome::Cancelled)
    } else {
        match SshChild::spawn(pinned, host, command, socket.path(), remote, worker) {
            Ok(mut ssh) => supervise(
                &mut ssh,
                bridge,
                receipt_tag,
                nonce,
                ready,
                publish,
                cancelled,
            ),
            Err(_) => finish_bridge(bridge, unavailable()),
        }
    };
    finish_socket(socket, outcome)
}

#[allow(clippy::too_many_arguments)]
fn supervise(
    ssh: &mut SshChild,
    bridge: Bridge,
    receipt_tag: &str,
    nonce: &str,
    ready: &mut dyn Ready,
    publish: impl FnOnce(ReadyPort) -> bool,
    cancelled: &dyn Fn() -> bool,
) -> Outcome {
    if ssh.setup().is_err() {
        let outcome = finish_bridge(bridge, unavailable());
        return if ssh.kill_and_reap() {
            outcome
        } else {
            Outcome::Unconfirmed
        };
    }
    let mut control = Control::new(receipt_tag, nonce);
    let mut launch = launch_payload(ready);
    let mut on_ready = Some(publish);
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
            .drain(ssh, pre_ready.then_some(&mut *ready))
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
        let ready_port = if pre_ready {
            match ready.poll(cancelled) {
                Ok(port) => port,
                Err(ReadyFailure::Cancelled) => break Outcome::Cancelled,
                Err(ReadyFailure::Rejected) => break Outcome::Rejected(ErrorCode::TransportLost),
            }
        } else {
            None
        };
        if ready_port.is_some() && control.drain(ssh, None).is_err() {
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
        if let Some(port) = ready_port
            && let Some(publish) = on_ready.take()
            && !publish(port)
        {
            break Outcome::Cancelled;
        }
        if control.prepared() && !control.launched() {
            match ssh.send_all(&mut launch) {
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
    super::settle(
        trigger,
        control.launched(),
        on_ready.is_none(),
        control.terminal(),
    )
}

/// The launch signal plus any transport credential, written as one payload so
/// the supervisor cannot observe a launch without its credential.
fn launch_payload(ready: &dyn Ready) -> Vec<u8> {
    let mut payload = vec![b'S'];
    if let Some(secret) = ready.launch_secret() {
        payload.extend_from_slice(secret.as_bytes());
        payload.push(b'\n');
    }
    payload
}
