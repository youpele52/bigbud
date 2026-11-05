#![allow(clippy::unwrap_used)]
use super::*;
use std::{cell::Cell, io::Cursor};

fn frame() -> Vec<u8> {
    let mut bytes = (PAYLOAD_BYTES as u32).to_be_bytes().to_vec();
    bytes.extend([1, 3]);
    bytes.extend([7; 32]);
    bytes
}

#[test]
fn every_fragment_size_and_role_decodes_without_read_ahead() {
    for (tag, role) in [
        (1, Role::Guard),
        (2, Role::Owner),
        (3, Role::Worker),
        (4, Role::Broker),
    ] {
        for chunk in 1..=38 {
            let mut bytes = frame();
            bytes[5] = tag;
            bytes.extend([99; 10]);
            let mut input = Cursor::new(bytes);
            let now = Instant::now();
            let decoded = read_frame(
                now + Duration::from_secs(1),
                || now,
                |out, _| {
                    let count = chunk.min(out.len());
                    input.read(&mut out[..count])
                },
            )
            .unwrap();
            assert_eq!(decoded, (role, [7; 32]));
            assert_eq!(input.position(), 38, "suffix must remain for the lifeline");
        }
    }
}

#[test]
fn invalid_length_is_rejected_before_reading_or_allocating_payload() {
    for length in [0_u32, 1, 33, 35, u32::MAX] {
        let mut input = Cursor::new(length.to_be_bytes());
        let now = Instant::now();
        let error = read_frame(
            now + Duration::from_secs(1),
            || now,
            |out, _| input.read(out),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(input.position(), 4);
    }
}

#[test]
fn malformed_version_and_role_refuse() {
    for (index, value) in [(4, 0), (4, 2), (5, 0), (5, 5), (5, 255)] {
        let mut bytes = frame();
        bytes[index] = value;
        let mut input = Cursor::new(bytes);
        let now = Instant::now();
        assert_eq!(
            read_frame(
                now + Duration::from_secs(1),
                || now,
                |out, _| input.read(out)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[test]
fn every_truncated_prefix_is_eof_not_an_authenticated_frame() {
    for length in 0..38 {
        let mut input = Cursor::new(frame()[..length].to_vec());
        let now = Instant::now();
        assert_eq!(
            read_frame(
                now + Duration::from_secs(1),
                || now,
                |out, _| input.read(out)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}

#[test]
fn drip_feed_and_retryable_errors_never_extend_absolute_deadline() {
    for error in [
        None,
        Some(io::ErrorKind::Interrupted),
        Some(io::ErrorKind::WouldBlock),
        Some(io::ErrorKind::TimedOut),
    ] {
        let start = Instant::now();
        let now = Cell::new(start);
        let deadline = start + Duration::from_millis(5);
        let mut input = Cursor::new(frame());
        let mut budgets = Vec::new();
        let result = read_frame(
            deadline,
            || now.get(),
            |out, remaining| {
                budgets.push(remaining);
                now.set(now.get() + Duration::from_millis(1));
                match error {
                    Some(kind) => Err(io::Error::from(kind)),
                    None => input.read(&mut out[..1]),
                }
            },
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(
            budgets,
            (1..=5).rev().map(Duration::from_millis).collect::<Vec<_>>()
        );
    }
}

#[test]
fn final_ready_bytes_at_deadline_are_rejected_and_expired_start_never_reads() {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(1);
    let now = Cell::new(start);
    let mut input = Cursor::new(frame());
    let result = read_frame(
        deadline,
        || now.get(),
        |out, _| {
            let count = input.read(out)?;
            if input.position() == 38 {
                now.set(deadline);
            }
            Ok(count)
        },
    );
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        read_frame(deadline, || deadline, |_, _| panic!("expired read"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
}

#[test]
fn nonretryable_io_error_is_preserved() {
    let now = Instant::now();
    assert_eq!(
        read_frame(
            now + Duration::from_secs(1),
            || now,
            |_, _| Err(io::ErrorKind::ConnectionReset.into())
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::ConnectionReset
    );
}
