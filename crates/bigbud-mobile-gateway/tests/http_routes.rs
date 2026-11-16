//! HTTP surface: allowlist, header hygiene, framing limits, pairing forwarding.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::time::Duration;

use support::{Behavior, CREDENTIAL, EXTERNAL_HOST, config, raw, spawn_backend, start};

async fn no_backend_request(backend: &mut support::FakeBackend) {
    let none = tokio::time::timeout(Duration::from_millis(300), backend.requests.recv()).await;
    assert!(none.is_err(), "backend was contacted: {none:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_full_rpc_unlisted_and_encoded_routes_before_any_upstream_connection() {
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let gateway = start(config(backend.address));
    for (target, status) in [
        ("/ws?token=x", "404"),
        ("/", "404"),
        ("/api/projects", "404"),
        ("/api/mobile/sessions", "404"),
        ("/mobile/../ws", "400"),
        ("/mobile/%2e%2e/ws", "400"),
        ("/mobile/a%2Fb", "400"),
        ("/mobile//x", "400"),
        ("/api/mobile/pairing/a.b", "404"),
    ] {
        let response = raw(
            gateway.address,
            format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{target}: {response}"
        );
    }
    let absolute = raw(
        gateway.address,
        b"GET http://evil/ws HTTP/1.1\r\nHost: x\r\n\r\n",
    )
    .await;
    assert!(absolute.starts_with("HTTP/1.1 4"), "{absolute}");
    no_backend_request(&mut backend).await;
    gateway.shutdown.shutdown();
    gateway.worker.join().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn deadline_closes_stalled_descriptor_upstream_connection() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for partial_body in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = listener.local_addr().unwrap();
        let backend = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0_u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).await.unwrap(), 1);
                head.push(byte[0]);
            }
            if partial_body {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\n\r\n{")
                    .await
                    .unwrap();
            }
            tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte)).await
        });
        let mut configured = config(upstream);
        configured.limits.upstream_request_timeout = Duration::from_millis(100);
        let gateway = start(configured);
        let response = raw(
            gateway.address,
            b"GET /api/mobile/handshake HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 504"), "{response}");
        let closed = backend.await.unwrap();
        gateway.shutdown.shutdown();
        gateway.worker.join().unwrap();
        assert!(
            matches!(closed, Ok(Ok(0))),
            "stalled upstream was not closed: {closed:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_only_exact_get_descriptor_with_rebuilt_gateway_credential() {
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let gateway = start(config(backend.address));
    for (method, target, status) in [
        ("POST", "/api/mobile/handshake", "405"),
        ("OPTIONS", "/api/mobile/handshake", "405"),
        ("GET", "/api/mobile/handshake?", "400"),
        ("GET", "/api/mobile/handshake?token=x", "400"),
        ("GET", "/api/mobile/handshake/other", "404"),
    ] {
        let response = raw(
            gateway.address,
            format!("{method} {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{response}"
        );
    }
    no_backend_request(&mut backend).await;
    let response = raw(gateway.address, b"GET /api/mobile/handshake HTTP/1.1\r\nHost: forged-host\r\nX-Bigbud-Mobile-Gateway: forged-credential\r\nAuthorization: Bearer private-client-token\r\nCookie: secret-cookie\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let seen = tokio::time::timeout(Duration::from_secs(3), backend.requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(seen.starts_with("get /api/mobile/handshake http/1.1\r\n"));
    assert!(seen.contains(&format!(
        "x-bigbud-mobile-gateway: {}\r\n",
        CREDENTIAL.to_ascii_lowercase()
    )));
    assert!(seen.contains(&format!("host: {EXTERNAL_HOST}\r\n")));
    for value in [
        "forged-host",
        "forged-credential",
        "private-client-token",
        "secret-cookie",
    ] {
        assert!(!seen.contains(value), "{value} leaked");
    }
    gateway.shutdown.shutdown();
    gateway.worker.join().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_pairing_exchange_with_rebuilt_headers_and_strips_response_hops() {
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let gateway = start(config(backend.address));
    let body = r#"{"secret":"s","label":"phone"}"#;
    let response = raw(
        gateway.address,
        format!(
            "POST /api/mobile/pairing/p1/exchange HTTP/1.1\r\nHost: attacker\r\nX-Forwarded-Proto: http\r\n\
             X-Forwarded-For: 6.6.6.6\r\nForwarded: for=6.6.6.6\r\nTailscale-User-Login: mallory\r\n\
             Cookie: a=b\r\nX-Bigbud-Mobile-Gateway: forged\r\nTE: trailers\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 200") && response.ends_with("{\"ok\":true}"),
        "{response}"
    );
    assert!(
        !response.to_ascii_lowercase().contains("x-hop"),
        "{response}"
    );
    let seen = backend.requests.recv().await.unwrap();
    assert!(
        seen.starts_with("post /api/mobile/pairing/p1/exchange http/1.1\r\n"),
        "{seen}"
    );
    assert!(
        seen.contains(&format!("host: {EXTERNAL_HOST}\r\n"))
            && seen.contains("x-forwarded-proto: https\r\n")
    );
    assert!(seen.contains(&format!(
        "x-bigbud-mobile-gateway: {}\r\n",
        CREDENTIAL.to_ascii_lowercase()
    )));
    for forged in [
        "attacker",
        "6.6.6.6",
        "mallory",
        "cookie",
        "forged",
        "te: trailers",
    ] {
        assert!(!seen.contains(forged), "{forged} leaked: {seen}");
    }
    assert!(seen.ends_with(body));
}

#[tokio::test(flavor = "multi_thread")]
async fn enforces_body_framing_and_limits() {
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let gateway = start(config(backend.address));
    let exchange = "POST /api/mobile/pairing/p1/exchange HTTP/1.1\r\nHost: x\r\n";
    for (extra, status) in [
        ("Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "501"),
        ("Content-Length: 999999999\r\n\r\n", "413"),
        ("\r\n", "411"),
        ("Content-Length: +2\r\n\r\n{}", "400"),
        ("Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}", "400"),
    ] {
        let response = raw(gateway.address, format!("{exchange}{extra}").as_bytes()).await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{extra:?}: {response}"
        );
    }
    let status_with_body = raw(
        gateway.address,
        b"GET /api/mobile/pairing/p1 HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n\r\nabc",
    )
    .await;
    assert!(
        status_with_body.starts_with("HTTP/1.1 400"),
        "{status_with_body}"
    );
    let oversized_head = format!(
        "GET /mobile HTTP/1.1\r\nHost: x\r\nX-Pad: {}\r\n\r\n",
        "a".repeat(32 * 1024)
    );
    let response = raw(gateway.address, oversized_head.as_bytes()).await;
    assert!(
        response.starts_with("HTTP/1.1 431") || response.is_empty(),
        "{response}"
    );
    no_backend_request(&mut backend).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_absent_backend_and_rate_limits_pairing() {
    let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = unused.local_addr().unwrap();
    drop(unused);
    let gateway = start(config(address));
    let response = raw(
        gateway.address,
        b"GET /api/mobile/pairing/p1 HTTP/1.1\r\nHost: x\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 502"), "{response}");

    let backend = spawn_backend(Behavior::HttpOk).await;
    let mut limited = config(backend.address);
    limited.limits.pairing_exchange_per_window = 1;
    let gateway = start(limited);
    let exchange =
        b"POST /api/mobile/pairing/p1/exchange HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}";
    assert!(
        raw(gateway.address, exchange)
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert!(
        raw(gateway.address, exchange)
            .await
            .starts_with("HTTP/1.1 429")
    );
    // Attempts on one pairing ID never lock out another.
    let other =
        b"POST /api/mobile/pairing/p2/exchange HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}";
    assert!(
        raw(gateway.address, other)
            .await
            .starts_with("HTTP/1.1 200")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn drops_clients_that_never_finish_their_headers() {
    let backend = spawn_backend(Behavior::HttpOk).await;
    let mut slow = config(backend.address);
    slow.limits.head_read_timeout = Duration::from_millis(300);
    let gateway = start(slow);
    let started = std::time::Instant::now();
    let response = raw(gateway.address, b"GET /mobile HTTP/1.1\r\nHost: x\r\n").await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "held for {:?}",
        started.elapsed()
    );
    assert!(
        response.is_empty() || response.starts_with("HTTP/1.1 408"),
        "{response}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_assets_and_spa_routes_without_the_backend() {
    let dir = std::env::temp_dir().join(format!("bigbud-gw-http-assets-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<main>mobile</main>").unwrap();
    std::fs::write(dir.join("assets/app.js"), "x".repeat(100_000)).unwrap();
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let mut with_assets = config(backend.address);
    with_assets.assets_dir = Some(dir.clone());
    let gateway = start(with_assets);
    let spa = raw(
        gateway.address,
        b"GET /mobile/pair/p1?backend=x HTTP/1.1\r\nHost: x\r\n\r\n",
    )
    .await;
    assert!(
        spa.starts_with("HTTP/1.1 200") && spa.ends_with("<main>mobile</main>"),
        "{spa}"
    );
    let script = raw(
        gateway.address,
        b"GET /mobile/assets/app.js HTTP/1.1\r\nHost: x\r\n\r\n",
    )
    .await;
    assert!(script.contains("text/javascript") && script.ends_with(&"x".repeat(100_000)));
    no_backend_request(&mut backend).await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_only_one_request_per_connection() {
    let mut backend = spawn_backend(Behavior::HttpOk).await;
    let gateway = start(config(backend.address));
    // Two pipelined requests: the second must never reach the backend.
    let response = raw(
        gateway.address,
        b"GET /api/mobile/pairing/p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /api/mobile/pairing/p2 HTTP/1.1\r\nHost: x\r\n\r\n",
    )
    .await;
    assert_eq!(response.matches("HTTP/1.1 ").count(), 1, "{response}");
    assert!(
        response.to_ascii_lowercase().contains("connection: close"),
        "{response}"
    );
    assert!(
        backend
            .requests
            .recv()
            .await
            .unwrap()
            .contains("/api/mobile/pairing/p1")
    );
    let second = tokio::time::timeout(Duration::from_millis(300), backend.requests.recv()).await;
    assert!(second.is_err(), "second pipelined request was forwarded");
}
