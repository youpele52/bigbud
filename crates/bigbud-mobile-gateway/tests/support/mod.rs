//! Fake backend and gateway harness for integration tests.
// `result_large_err`: tungstenite dictates the handshake callback signature.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::result_large_err
)]

use std::net::SocketAddr;
use std::thread::JoinHandle;
use std::time::Duration;

use bigbud_mobile_gateway::{
    ExternalOrigin, Gateway, GatewayConfig, Limits, ShutdownHandle, Upstream,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

pub const EXTERNAL_HOST: &str = "desk.tail1.ts.net";
pub const CREDENTIAL: &str = "test-credential-0123456789abcdefghij";

#[derive(Clone, Copy)]
pub enum Behavior {
    HttpOk,
    WsEcho,
    /// Accept, then send `n` outbound messages of `size` bytes each.
    WsSend {
        count: usize,
        size: usize,
    },
    WsDropAfterFirst,
    /// Accept, then close with this code and reason.
    WsCloseWith(u16),
    /// Raw HTTP answers to the upgrade.
    WsRaw(&'static str),
}

pub struct FakeBackend {
    pub address: SocketAddr,
    /// Request heads (lowercased header lines) and, for HTTP, bodies.
    pub requests: mpsc::UnboundedReceiver<String>,
    /// Sizes of WebSocket messages the backend received, then `usize::MAX` at close.
    pub messages: mpsc::UnboundedReceiver<usize>,
}

async fn read_head(stream: &mut TcpStream) -> String {
    let mut out = Vec::new();
    let mut byte = [0_u8; 1];
    while !out.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        out.push(byte[0]);
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

async fn serve_one(
    mut stream: TcpStream,
    behavior: Behavior,
    requests: mpsc::UnboundedSender<String>,
    messages: mpsc::UnboundedSender<usize>,
) {
    match behavior {
        Behavior::HttpOk => {
            let head = read_head(&mut stream).await;
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut body = vec![0_u8; length];
            stream.read_exact(&mut body).await.unwrap();
            let _ = requests.send(format!("{head}{}", String::from_utf8_lossy(&body)));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-hop: 1\r\nconnection: close, x-hop\r\ncontent-length: 11\r\n\r\n{\"ok\":true}")
                .await;
        }
        Behavior::WsRaw(answer) => {
            let head = read_head(&mut stream).await;
            let _ = requests.send(head);
            let _ = stream.write_all(answer.as_bytes()).await;
        }
        Behavior::WsEcho
        | Behavior::WsSend { .. }
        | Behavior::WsDropAfterFirst
        | Behavior::WsCloseWith(_) => {
            let record = requests.clone();
            let callback = move |request: &Request, response: Response| {
                let mut head = format!("{} {}\r\n", request.method(), request.uri());
                for (name, value) in request.headers() {
                    head.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap_or("?")));
                }
                let _ = record.send(head.to_ascii_lowercase());
                Ok(response)
            };
            let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
                return;
            };
            match behavior {
                Behavior::WsSend { count, size } => {
                    for _ in 0..count {
                        if socket
                            .send(Message::binary(vec![0x61_u8; size]))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    let _ = messages.send(usize::MAX);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                Behavior::WsCloseWith(code) => {
                    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
                    let frame = CloseFrame {
                        code: code.into(),
                        reason: "revoked".into(),
                    };
                    let _ = socket.close(Some(frame)).await;
                }
                Behavior::WsDropAfterFirst => {
                    if let Some(Ok(message)) = socket.next().await {
                        let _ = messages.send(message.len());
                    }
                }
                _ => {
                    while let Some(Ok(message)) = socket.next().await {
                        if message.is_close() {
                            break;
                        }
                        let _ = messages.send(message.len());
                        if socket.send(message).await.is_err() {
                            break;
                        }
                    }
                    let _ = messages.send(usize::MAX);
                }
            }
        }
    }
}

pub async fn spawn_backend(behavior: Behavior) -> FakeBackend {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, requests) = mpsc::unbounded_channel();
    let (message_tx, messages) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(
                stream,
                behavior,
                request_tx.clone(),
                message_tx.clone(),
            ));
        }
    });
    FakeBackend {
        address,
        requests,
        messages,
    }
}

pub fn config(upstream: SocketAddr) -> GatewayConfig {
    GatewayConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        upstream: Upstream::Tcp(upstream),
        external_origin: ExternalOrigin::parse(&format!("https://{EXTERNAL_HOST}")).unwrap(),
        assets_dir: None,
        upstream_credential: Some(CREDENTIAL.to_owned()),
        limits: Limits::default(),
    }
}

pub struct RunningGateway {
    pub address: SocketAddr,
    pub shutdown: ShutdownHandle,
    pub worker: JoinHandle<()>,
}

/// Runs the gateway on its own thread and runtime, as the binary does.
pub fn start(config: GatewayConfig) -> RunningGateway {
    let gateway = Gateway::bind(config).unwrap();
    let address = gateway.local_addr().unwrap();
    let shutdown = gateway.shutdown_handle();
    let worker = std::thread::spawn(move || gateway.run().unwrap());
    RunningGateway {
        address,
        shutdown,
        worker,
    }
}

/// Sends raw bytes and returns everything received until close (bounded).
pub async fn raw(address: SocketAddr, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

pub const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

pub fn upgrade_request(extra: &str) -> String {
    format!(
        "GET /mobile-ws?token=t HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {KEY}\r\n{extra}\r\n"
    )
}

pub type ClientSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// A real WebSocket client through the gateway, allowed to send oversized messages.
pub async fn ws_client(
    address: SocketAddr,
) -> Result<ClientSocket, tokio_tungstenite::tungstenite::Error> {
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    tokio_tungstenite::connect_async_with_config(
        format!("ws://{address}/mobile-ws?token=t"),
        Some(config),
        false,
    )
    .await
    .map(|(socket, _)| socket)
}
