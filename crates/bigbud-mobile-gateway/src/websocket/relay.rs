//! Opaque, bounded WebSocket relay. Text and binary messages pass through
//! unchanged and are never decoded. Each direction holds at most one message
//! in flight: the next message is read only after the previous one was
//! written, so a slow side applies backpressure instead of growing a queue.
//! Pings are answered locally by tungstenite; close frames are forwarded.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Semaphore, watch};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::CapacityError;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::config::Limits;
use crate::upstream::UpstreamStream;

/// Closing is best effort and must not hold a slot for a full write deadline.
const CLOSE_DEADLINE: Duration = Duration::from_secs(2);

type PhoneSocket = WebSocketStream<TokioIo<Upgraded>>;
type BackendSocket = WebSocketStream<UpstreamStream>;

enum Step {
    Forward(Message),
    Ignore,
    /// The peer sent a close frame (its code, if any).
    PeerClosed(Option<CloseFrame>),
    /// The gateway detected a failure; the code describes it to that peer.
    End(&'static str, Option<CloseCode>),
}

fn classify(read: Option<Result<Message, WsError>>) -> Step {
    match read {
        None => Step::End("peer-gone", None),
        Some(Ok(Message::Close(frame))) => Step::PeerClosed(frame),
        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => Step::Ignore,
        Some(Ok(message)) => Step::Forward(message),
        Some(Err(WsError::Capacity(CapacityError::MessageTooLong { .. }))) => {
            Step::End("message-too-large", Some(CloseCode::Size))
        }
        Some(Err(WsError::Protocol(_))) => Step::End("protocol-error", Some(CloseCode::Protocol)),
        Some(Err(_)) => Step::End("transport-error", None),
    }
}

/// Admits the message against the process-wide byte budget, then writes it.
/// Both steps share one deadline; the permit is released once written.
async fn send_with_deadline<S>(
    socket: &mut WebSocketStream<S>,
    message: Message,
    deadline: Duration,
    in_flight: &Semaphore,
) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Config validation guarantees every admitted message fits in u32.
    let Ok(bytes) = u32::try_from(message.len()) else {
        return false;
    };
    let admitted_and_sent = async {
        let _permit = in_flight.acquire_many(bytes).await.ok()?;
        socket.send(message).await.ok()
    };
    matches!(timeout(deadline, admitted_and_sent).await, Ok(Some(())))
}

async fn close<S>(socket: &mut WebSocketStream<S>, frame: Option<CloseFrame>, deadline: Duration)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Best effort: the peer may already be gone, and the socket drops next.
    let _closed = timeout(deadline, socket.close(frame)).await;
}

/// A close frame the gateway originates (no reason text).
fn coded(code: CloseCode) -> Option<CloseFrame> {
    Some(CloseFrame {
        code,
        reason: "".into(),
    })
}

/// Relays until either side ends, the idle deadline passes or shutdown is
/// requested. Returns a short label for diagnostics.
pub async fn relay(
    mut phone: PhoneSocket,
    mut backend: BackendSocket,
    limits: &Limits,
    in_flight: &Semaphore,
    mut shutdown: watch::Receiver<bool>,
) -> &'static str {
    let write_deadline = limits.write_timeout;
    let mut idle_deadline = Instant::now() + limits.ws_idle_timeout;
    let (label, phone_frame, backend_frame) = loop {
        tokio::select! {
            read = phone.next() => match classify(read) {
                Step::Forward(message) => {
                    idle_deadline = Instant::now() + limits.ws_idle_timeout;
                    if !send_with_deadline(&mut backend, message, write_deadline, in_flight).await {
                        break ("backend-write-failed", coded(CloseCode::Error), None);
                    }
                }
                Step::Ignore => idle_deadline = Instant::now() + limits.ws_idle_timeout,
                Step::PeerClosed(_) => break ("phone-closed", None, coded(CloseCode::Away)),
                Step::End(label, code) => break (label, code.and_then(coded), coded(CloseCode::Away)),
            },
            read = backend.next() => match classify(read) {
                Step::Forward(message) => {
                    idle_deadline = Instant::now() + limits.ws_idle_timeout;
                    if !send_with_deadline(&mut phone, message, write_deadline, in_flight).await {
                        break ("phone-write-failed", None, coded(CloseCode::Away));
                    }
                }
                Step::Ignore => idle_deadline = Instant::now() + limits.ws_idle_timeout,
                // A backend close frame (for example an authorization close) passes
                // through; a failed or vanished backend tells the phone to reconnect.
                Step::PeerClosed(code) => {
                    break ("backend-closed", code.or_else(|| coded(CloseCode::Normal)), None)
                }
                Step::End(label, _) => break (label, coded(CloseCode::Again), None),
            },
            () = sleep_until(idle_deadline) => break ("idle-timeout", coded(CloseCode::Away), coded(CloseCode::Away)),
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break ("shutdown", coded(CloseCode::Restart), coded(CloseCode::Away));
                }
            }
        }
    };
    close(&mut phone, phone_frame, CLOSE_DEADLINE).await;
    close(&mut backend, backend_frame, CLOSE_DEADLINE).await;
    label
}
