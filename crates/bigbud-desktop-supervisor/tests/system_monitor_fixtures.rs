use std::{error::Error, io};

use bigbud_desktop_supervisor::monitor_v1 as v1;
use prost::Message;

#[test]
fn shared_v1_frames_decode_to_expected_messages() -> Result<(), Box<dyn Error>> {
    let fixture = include_str!("../../../protocol/system-monitor/fixtures/v1.frames");
    let mut seen = Vec::new();
    for line in fixture.lines() {
        let (name, hex) = line
            .split_once('=')
            .ok_or_else(|| io::Error::other("invalid fixture"))?;
        if hex.len() % 2 != 0 {
            return Err(io::Error::other("invalid fixture hex length").into());
        }
        let bytes: Vec<u8> = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| -> Result<u8, Box<dyn Error>> {
                Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?)
            })
            .collect::<Result<_, Box<dyn Error>>>()?;
        let length = u32::from_be_bytes(bytes[..4].try_into()?) as usize;
        if length != bytes.len() - 4 {
            return Err(io::Error::other("fixture length mismatch").into());
        }
        let frame = v1::Frame::decode(&bytes[4..])?;
        let matches = matches!(
            (name, frame.payload),
            ("hello", Some(v1::frame::Payload::Hello(_)))
                | ("snapshot", Some(v1::frame::Payload::Snapshot(_)))
                | ("process_query", Some(v1::frame::Payload::ProcessQuery(_)))
                | ("process_page", Some(v1::frame::Payload::ProcessPage(_)))
                | ("error", Some(v1::frame::Payload::Error(_)))
                | (
                    "collection_status",
                    Some(v1::frame::Payload::CollectionStatus(_))
                )
        );
        if !matches {
            return Err(io::Error::other("fixture payload mismatch").into());
        }
        seen.push(name);
    }
    if seen.len() != 6 {
        return Err(io::Error::other("missing fixtures").into());
    }
    Ok(())
}
