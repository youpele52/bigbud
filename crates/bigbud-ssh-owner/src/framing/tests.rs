#![allow(clippy::expect_used)]

use std::io::{self, Cursor, Read};

use super::{Endpoint, FrameError};

fn golden(name: &str) -> Vec<u8> {
    let hex = include_str!("../../../../protocol/ssh-owner/v1.golden.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
        .expect("shared vector exists");
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("hex is UTF-8");
            u8::from_str_radix(pair, 16).expect("valid hex byte")
        })
        .collect()
}

#[test]
fn exact_directional_caps_match_shared_headers() {
    for (sender, receiver, exact, over, cap) in [
        (
            Endpoint::Client,
            Endpoint::Owner,
            "client_maximum_prefix",
            "client_oversized_prefix",
            65_536,
        ),
        (
            Endpoint::Owner,
            Endpoint::Client,
            "owner_maximum_prefix",
            "owner_oversized_prefix",
            8_388_608,
        ),
    ] {
        let exact: [u8; 4] = golden(exact).try_into().expect("four-byte header");
        assert_eq!(receiver.decode_inbound_header(exact).expect("valid"), cap);

        let mut wire = Vec::new();
        let mut payload = vec![0xa5; cap];
        sender.write_frame(&mut wire, &payload).expect("exact cap");
        assert_eq!(wire.len(), cap + 4);
        assert!(wire.starts_with(&exact));
        assert_eq!(
            receiver
                .read_frame(&mut wire.as_slice())
                .expect("read")
                .as_deref(),
            Some(payload.as_slice())
        );

        let over = golden(over);
        let mut wire = Cursor::new([over.as_slice(), b"unread"].concat());
        assert!(matches!(
            receiver.read_frame(&mut wire),
            Err(FrameError::Oversized { actual, maximum }) if actual == cap + 1 && maximum == cap
        ));
        assert_eq!(wire.position(), 4, "must not read the body");

        let mut wire = Vec::new();
        payload.push(0);
        assert!(matches!(
            sender.write_frame(&mut wire, &payload),
            Err(FrameError::Oversized { actual, maximum }) if actual == cap + 1 && maximum == cap
        ));
        assert!(wire.is_empty(), "must not write even the header");
    }
}

#[test]
fn rejects_empty_frames_without_touching_body_or_writer() {
    let mut input = Cursor::new([golden("empty_payload").as_slice(), b"unread"].concat());
    assert!(matches!(
        Endpoint::Owner.read_frame(&mut input),
        Err(FrameError::Empty)
    ));
    assert_eq!(input.position(), 4);

    let mut output = Vec::new();
    assert!(matches!(
        Endpoint::Client.write_frame(&mut output, b""),
        Err(FrameError::Empty)
    ));
    assert!(output.is_empty());
}

#[test]
fn clean_eof_is_distinct_from_truncated_header_and_payload() {
    assert_eq!(Endpoint::Owner.read_frame(&mut &[][..]).expect("EOF"), None);
    assert!(matches!(
        Endpoint::Owner.read_frame(&mut golden("truncated_prefix").as_slice()),
        Err(FrameError::ReadHeader(error)) if error.kind() == io::ErrorKind::UnexpectedEof
    ));
    assert!(matches!(
        Endpoint::Owner.read_frame(&mut golden("truncated_payload").as_slice()),
        Err(FrameError::ReadPayload(error)) if error.kind() == io::ErrorKind::UnexpectedEof
    ));
    assert!(matches!(
        Endpoint::Owner.read_frame(&mut [0, 0, 0, 1].as_slice()),
        Err(FrameError::ReadPayload(error)) if error.kind() == io::ErrorKind::UnexpectedEof
    ));
}

struct Fragmented<'a> {
    remaining: &'a [u8],
    interrupt_next: bool,
}

impl Read for Fragmented<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.interrupt_next = !self.interrupt_next;
        if self.interrupt_next {
            return Err(io::ErrorKind::Interrupted.into());
        }
        match buf.first_mut() {
            Some(byte) => self.remaining.read(std::slice::from_mut(byte)),
            None => Ok(0),
        }
    }
}

#[test]
fn fragmented_reads_preserve_coalesced_frame_boundaries() {
    let first = golden("hello");
    let second = golden("list_path");
    let wire = [first.as_slice(), second.as_slice()].concat();
    let mut fragmented = Fragmented {
        remaining: &wire,
        interrupt_next: false,
    };
    for mut reader in [&mut fragmented as &mut dyn Read, &mut wire.as_slice()] {
        for expected in [&first, &second] {
            let payload = Endpoint::Owner
                .read_frame(&mut reader)
                .expect("read")
                .expect("frame");
            let mut output = Vec::new();
            Endpoint::Client
                .write_frame(&mut output, &payload)
                .expect("write");
            assert_eq!(&output, expected);
        }
        assert_eq!(Endpoint::Owner.read_frame(&mut reader).expect("EOF"), None);
    }
}
