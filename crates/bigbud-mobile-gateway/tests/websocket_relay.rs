//! Relay behavior: parity, message budgets, slow peers, loss, idle and shutdown.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod support;

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use support::{Behavior, ClientSocket, config, spawn_backend, start, ws_client};

/// Reads until the socket closes; returns the close code, if any.
async fn close_code(socket: &mut ClientSocket, within: Duration) -> Option<CloseCode> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), socket.next()).await {
            Ok(Some(Ok(Message::Close(frame)))) => return frame.map(|frame| frame.code),
            Ok(Some(Ok(_))) | Err(_) => continue,
            Ok(Some(Err(_)) | None) => return None,
        }
    }
    panic!("socket did not close within {within:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_text_and_binary_messages_unchanged() {
    let backend = spawn_backend(Behavior::WsEcho).await;
    let gateway = start(config(backend.address));
    let mut socket = ws_client(gateway.address).await.unwrap();
    for message in [
        Message::text("{\"_tag\":\"Request\"}"),
        Message::binary(vec![7_u8; 900_000]),
    ] {
        socket.send(message.clone()).await.unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echoed, message);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn closes_with_1009_when_a_phone_message_exceeds_the_budget_even_if_fragmented() {
    for fragmented in [false, true] {
        let mut backend = spawn_backend(Behavior::WsEcho).await;
        let gateway = start(config(backend.address));
        let mut socket = ws_client(gateway.address).await.unwrap();
        let oversized = vec![1_u8; 1024 * 1024 + 1];
        if fragmented {
            // Two frames, each under the frame limit, summing over the message limit.
            use tokio_tungstenite::tungstenite::protocol::frame::{
                Frame,
                coding::{Data, OpCode},
            };
            let (first, second) = oversized.split_at(600_000);
            let mut start = Frame::message(first.to_vec(), OpCode::Data(Data::Binary), false);
            start.header_mut().is_final = false;
            socket.send(Message::Frame(start)).await.unwrap();
            let rest = Frame::message(second.to_vec(), OpCode::Data(Data::Continue), true);
            let _ = socket.send(Message::Frame(rest)).await;
        } else {
            let _ = socket.send(Message::binary(oversized)).await;
        }
        assert_eq!(
            close_code(&mut socket, Duration::from_secs(5)).await,
            Some(CloseCode::Size)
        );
        // Nothing of the oversized message reached the backend.
        let first = tokio::time::timeout(Duration::from_secs(5), backend.messages.recv())
            .await
            .unwrap();
        assert_eq!(first, Some(usize::MAX), "fragmented={fragmented}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bounds_backend_messages_to_the_outbound_budget() {
    let backend = spawn_backend(Behavior::WsSend {
        count: 1,
        size: 2048,
    })
    .await;
    let mut limited = config(backend.address);
    limited.limits.max_outbound_ws_message_bytes = 1024;
    let gateway = start(limited);
    let mut socket = ws_client(gateway.address).await.unwrap();
    // The backend broke the outbound budget: the phone is told to reconnect.
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(5)).await,
        Some(CloseCode::Again)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnects_a_phone_that_stops_reading() {
    let mut backend = spawn_backend(Behavior::WsSend {
        count: 4000,
        size: 64 * 1024,
    })
    .await;
    let mut limited = config(backend.address);
    limited.limits.write_timeout = Duration::from_millis(500);
    let gateway = start(limited);
    let socket = ws_client(gateway.address).await.unwrap();
    // Never read. The backend sender must be released (closed), not buffered for.
    let released = tokio::time::timeout(Duration::from_secs(20), backend.messages.recv()).await;
    assert_eq!(released.unwrap(), Some(usize::MAX));
    drop(socket);
    gateway.shutdown.shutdown();
    gateway.worker.join().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn stalled_readers_at_the_cap_are_bounded_by_admission_and_release_it() {
    let mut backend = spawn_backend(Behavior::WsSend {
        count: 400,
        size: 64 * 1024,
    })
    .await;
    let mut tight = config(backend.address);
    tight.limits.max_outbound_ws_message_bytes = 64 * 1024;
    tight.limits.max_inbound_ws_message_bytes = 64 * 1024;
    tight.limits.max_in_flight_bytes = 128 * 1024;
    tight.limits.write_timeout = Duration::from_millis(500);
    let gateway = start(tight);
    // Four phones that never read: at most two cap-sized messages are admitted at once.
    let mut stalled = Vec::new();
    for _ in 0..4 {
        stalled.push(ws_client(gateway.address).await.unwrap());
    }
    for _ in 0..4 {
        let released = tokio::time::timeout(Duration::from_secs(20), backend.messages.recv()).await;
        assert_eq!(
            released.unwrap(),
            Some(usize::MAX),
            "a stalled relay held its backend open"
        );
    }
    drop(stalled);
    // Every admitted byte was returned: a reading phone gets data again.
    let mut reader = ws_client(gateway.address).await.unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
    assert_eq!(message.unwrap().unwrap().unwrap().len(), 64 * 1024);
}

#[tokio::test(flavor = "multi_thread")]
async fn backend_loss_tells_the_phone_to_reconnect() {
    let mut backend = spawn_backend(Behavior::WsDropAfterFirst).await;
    let gateway = start(config(backend.address));
    let mut socket = ws_client(gateway.address).await.unwrap();
    socket.send(Message::text("hello")).await.unwrap();
    assert_eq!(backend.messages.recv().await, Some(5));
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(5)).await,
        Some(CloseCode::Again)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn passes_backend_close_codes_through_to_the_phone() {
    let backend = spawn_backend(Behavior::WsCloseWith(4401)).await;
    let gateway = start(config(backend.address));
    let mut socket = ws_client(gateway.address).await.unwrap();
    // Code and reason both arrive: the phone classifies the close by its reason.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(frame))) => return frame,
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(closed.code, CloseCode::from(4401));
    assert_eq!(closed.reason.as_str(), "revoked");
}

#[tokio::test(flavor = "multi_thread")]
async fn closes_idle_sockets_and_shuts_down_with_restart_code() {
    let backend = spawn_backend(Behavior::WsEcho).await;
    let mut idle = config(backend.address);
    idle.limits.ws_idle_timeout = Duration::from_millis(400);
    let gateway = start(idle);
    let mut socket = ws_client(gateway.address).await.unwrap();
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(5)).await,
        Some(CloseCode::Away)
    );

    let backend = spawn_backend(Behavior::WsEcho).await;
    let gateway = start(config(backend.address));
    let mut socket = ws_client(gateway.address).await.unwrap();
    let started = Instant::now();
    gateway.shutdown.shutdown();
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(5)).await,
        Some(CloseCode::Restart)
    );
    gateway.worker.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(6));
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_503_past_the_connection_budget() {
    let backend = spawn_backend(Behavior::WsEcho).await;
    let mut limited = config(backend.address);
    limited.limits.max_connections = 1;
    let gateway = start(limited);
    let held = ws_client(gateway.address).await.unwrap();
    let refused = support::raw(gateway.address, b"GET /mobile HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    drop(held);
}
