//! Upgrade validation on both legs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::time::Duration;

use support::{
    Behavior, CREDENTIAL, config, raw, spawn_backend, start, upgrade_request, ws_client,
};

#[tokio::test(flavor = "multi_thread")]
async fn completes_both_handshakes_with_valid_accept_keys() {
    let mut backend = spawn_backend(Behavior::WsEcho).await;
    let gateway = start(config(backend.address));
    let response = raw_until_head(gateway.address, upgrade_request("")).await;
    assert!(response.starts_with("http/1.1 101"), "{response}");
    // RFC 6455 sample key → accept.
    assert!(
        response.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=\r\n"),
        "{response}"
    );
    // Strict clients require exactly `Upgrade`, not a list including `close`.
    assert!(response.contains("connection: upgrade\r\n"), "{response}");
    let seen = backend.requests.recv().await.unwrap();
    assert!(seen.contains(&format!(
        "x-bigbud-mobile-gateway: {}",
        CREDENTIAL.to_ascii_lowercase()
    )));
    assert!(
        seen.contains("x-forwarded-proto: https") && !seen.contains("sec-websocket-extensions")
    );
    // The backend leg used its own fresh key, not the phone's.
    assert!(!seen.contains("dghlihnhbxbszsbub25jzq=="), "{seen}");
}

async fn raw_until_head(address: std::net::SocketAddr, request: String) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let mut byte = [0_u8; 1];
    while !out.ends_with(b"\r\n\r\n") {
        match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte)).await {
            Ok(Ok(1)) => out.push(byte[0]),
            _ => break,
        }
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_malformed_phone_upgrades_without_contacting_the_backend() {
    let mut backend = spawn_backend(Behavior::WsEcho).await;
    let gateway = start(config(backend.address));
    let cases = [
        (
            "GET /mobile-ws?token=t HTTP/1.1\r\nHost: x\r\n\r\n".to_owned(),
            "400",
        ),
        (
            upgrade_request("").replace("Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 8"),
            "426",
        ),
        (
            upgrade_request("").replace("dGhlIHNhbXBsZSBub25jZQ==", "not-a-key"),
            "400",
        ),
        (
            upgrade_request("").replace("Upgrade: websocket", "Upgrade: h2c"),
            "400",
        ),
        (upgrade_request("Content-Length: 4\r\n"), "400"),
        (upgrade_request("").replace("GET", "POST"), "405"),
    ];
    for (request, status) in cases {
        let response = raw(gateway.address, request.as_bytes()).await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{request:?} → {response}"
        );
    }
    let none = tokio::time::timeout(Duration::from_millis(300), backend.requests.recv()).await;
    assert!(none.is_err(), "backend contacted");
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_backend_authorization_failures_as_plain_http() {
    let backend = spawn_backend(Behavior::WsRaw(
        "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    ))
    .await;
    let gateway = start(config(backend.address));
    let response = raw(gateway.address, upgrade_request("").as_bytes()).await;
    assert!(response.starts_with("HTTP/1.1 401"), "{response}");
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_closed_when_the_backend_handshake_is_invalid() {
    for answer in [
        // Wrong accept key.
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n",
        // Missing upgrade header.
        "HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\n\r\n",
        // Garbage.
        "NOT HTTP\r\n\r\n",
    ] {
        let backend = spawn_backend(Behavior::WsRaw(answer)).await;
        let gateway = start(config(backend.address));
        let response = raw(gateway.address, upgrade_request("").as_bytes()).await;
        assert!(
            response.starts_with("HTTP/1.1 502"),
            "{answer:?} → {response}"
        );
        assert!(ws_client(gateway.address).await.is_err());
    }
}
