//! Production agent-proxy channel tests (no sshd, no network).
//!
//! The fake peer speaks exactly the mux slice the owner uses, so these cover the
//! framed duplex, separate stderr, explicit exit, cancellation, credits/queue
//! bounds and per-lease independence without a live host.

use super::test_support::{echo_proxy, proxy_pair, silent_proxy};
use super::*;
use crate::Token;
use crate::v1::ErrorCode;
use std::time::{Duration, Instant};

fn token(byte: u8) -> Token {
    [byte; 32]
}

fn drain_until(mut read: impl FnMut() -> Option<Vec<u8>>, deadline: Instant) -> Vec<u8> {
    let mut bytes = Vec::new();
    while Instant::now() < deadline {
        match read() {
            Some(chunk) if !chunk.is_empty() => bytes.extend(chunk),
            Some(_) | None => {
                if !bytes.is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    bytes
}

#[test]
fn production_proxy_frames_the_duplex_and_confirms_an_explicit_exit() {
    let (mut proxy, peer) = echo_proxy(token(1), 4242, b"hello\n", b"diag\n");
    proxy.grant_input_credit(64).unwrap();
    proxy.grant_output_credit(64).unwrap();
    proxy.send(b"ping\n").unwrap();
    proxy.half_close_input().unwrap();

    let output = drain_until(
        || proxy.receive().unwrap(),
        Instant::now() + Duration::from_secs(2),
    );
    assert_eq!(output, b"hello\n");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut stderr = Vec::new();
    while Instant::now() < deadline {
        assert!(proxy.drain_stderr().unwrap() <= MAX_STDERR);
        let (chunk, _) = proxy.stderr();
        stderr.extend(chunk);
        if !stderr.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(stderr, b"diag\n");

    let status = proxy.close(false, 1_000).unwrap();
    assert!(status.closed);
    assert_eq!(status.code, Some(0));
    assert_eq!(status.signal, None);
    assert_eq!(status.pid, 4242);
    peer.join();
}

#[test]
fn credit_and_queue_overload_are_typed_refusals_not_buffering() {
    let (mut proxy, peer) = echo_proxy(token(2), 7, b"ok\n", b"");
    // No credit yet: the owner must refuse rather than buffer.
    assert_eq!(proxy.send(b"x").err(), Some(ErrorCode::OperationDenied));
    assert_eq!(
        proxy.grant_input_credit(MAX_CREDITS + 1).err(),
        Some(ErrorCode::InvalidOperands)
    );
    assert_eq!(proxy.grant_input_credit(4).unwrap(), 4);
    assert_eq!(proxy.send(b"five!").err(), Some(ErrorCode::OperationDenied));
    assert_eq!(proxy.receive().err(), Some(ErrorCode::OperationDenied));
    assert_eq!(
        proxy.grant_output_credit(0).err(),
        Some(ErrorCode::InvalidOperands)
    );
    // A bounded send inside the window still succeeds.
    proxy.send(b"okay").unwrap();
    proxy.half_close_input().unwrap();
    let status = proxy.close(false, 1_000).unwrap();
    assert!(status.closed);
    peer.join();
}

#[test]
fn cancellation_without_an_exit_message_is_outcome_unknown() {
    let (mut proxy, peer) = silent_proxy(token(3), 9);
    assert_eq!(proxy.close(true, 50).err(), Some(ErrorCode::OutcomeUnknown));
    peer.join();
}

#[test]
fn stderr_is_separate_and_bounded_without_blocking_stdout() {
    let excessive = MAX_STDERR + 4096;
    let (mut proxy, peer) =
        proxy_pair(token(4), 11, "/owner/agent --proxy", move |mut channels| {
            channels
                .stdout
                .write_all(b"framed\n")
                .expect("remote stdout");
            channels
                .stderr
                .write_all(&vec![b'x'; excessive])
                .expect("remote stderr");
            channels.exit(0);
        });
    proxy.grant_output_credit(64).unwrap();
    let mut drained = 0usize;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        drained += proxy.drain_stderr().unwrap();
        if drained >= excessive {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let (stderr, truncated) = proxy.stderr();
    assert_eq!(drained, excessive);
    assert_eq!(stderr.len(), MAX_STDERR);
    assert!(truncated);
    let status = proxy.close(false, 1_000).unwrap();
    assert!(status.closed);
    peer.join();
}

#[test]
fn two_proxies_hold_independent_leases_and_one_close_leaves_the_other() {
    let (mut first, first_peer) = echo_proxy(token(5), 21, b"first\n", b"");
    let (mut second, second_peer) = echo_proxy(token(6), 22, b"second\n", b"");
    first.grant_input_credit(8).unwrap();
    second.grant_input_credit(8).unwrap();
    first.grant_output_credit(32).unwrap();
    second.grant_output_credit(32).unwrap();
    first.send(b"one").unwrap();
    second.send(b"two").unwrap();
    first.half_close_input().unwrap();
    second.half_close_input().unwrap();

    let first_status = first.close(false, 1_000).unwrap();
    assert!(first_status.closed);
    assert_eq!(first_status.lease, token(5));
    // The second lease is untouched by the first target's teardown.
    let second_status = second.status().unwrap();
    assert!(!second_status.closed);
    assert_eq!(second_status.lease, token(6));
    assert_eq!(second_status.pid, 22);
    let output = drain_until(
        || second.receive().unwrap(),
        Instant::now() + Duration::from_secs(2),
    );
    assert_eq!(output, b"second\n");
    let second_status = second.close(false, 1_000).unwrap();
    assert!(second_status.closed);
    first_peer.join();
    second_peer.join();
}

#[test]
fn send_after_confirmed_close_is_refused() {
    let (mut proxy, peer) = echo_proxy(token(7), 31, b"", b"");
    proxy.grant_input_credit(8).unwrap();
    proxy.half_close_input().unwrap();
    assert!(proxy.close(false, 1_000).unwrap().closed);
    assert_eq!(proxy.send(b"late").err(), Some(ErrorCode::OperationDenied));
    peer.join();
}

// Guard against an accidentally unbounded queue constant.
const _: () = {
    assert!(MAX_CREDITS > 0 && MAX_CREDITS <= 1024 * 1024);
    assert!(MAX_QUEUE > 0 && MAX_QUEUE <= 1024 * 1024);
    assert!(MAX_STDERR > 0 && MAX_STDERR <= MAX_QUEUE);
};
