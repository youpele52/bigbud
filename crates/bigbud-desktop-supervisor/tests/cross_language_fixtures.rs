use std::collections::HashMap;
use std::io::Cursor;

use bigbud_desktop_supervisor::{DEFAULT_MAX_FRAME_BYTES, canonical_batch_id, read_frame, v1};

fn fixtures() -> HashMap<&'static str, &'static str> {
    include_str!("../../../protocol/desktop-supervisor/fixtures/v1.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("hex fixture has odd length".to_owned());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
            u8::from_str_radix(text, 16).map_err(|error| error.to_string())
        })
        .collect()
}

#[test]
fn decodes_shared_frames_and_batch_identity() -> Result<(), String> {
    let fixtures = fixtures();
    for name in [
        "hello",
        "attach",
        "batch",
        "ack",
        "ack_accepted",
        "recovery",
        "error",
        "install_baseline",
        "baseline_installed",
    ] {
        let encoded = decode_hex(fixtures[name])?;
        let frame = read_frame(&mut Cursor::new(encoded), DEFAULT_MAX_FRAME_BYTES)
            .map_err(|error| error.to_string())?;
        if frame.is_none() {
            return Err(format!("fixture {name} decoded as EOF"));
        }
    }
    let encoded = decode_hex(fixtures["batch"])?;
    let Some(v1::Frame {
        payload: Some(v1::frame::Payload::EventBatch(batch)),
    }) = read_frame(&mut Cursor::new(encoded), DEFAULT_MAX_FRAME_BYTES)
        .map_err(|error| error.to_string())?
    else {
        return Err("batch fixture did not decode as EventBatch".to_owned());
    };
    if canonical_batch_id(&batch) != fixtures["batch_id"] {
        return Err("batch fixture identity does not match the canonical digest".to_owned());
    }
    Ok(())
}

#[test]
fn rejects_shared_truncated_frame() -> Result<(), String> {
    let fixtures = fixtures();
    let encoded = decode_hex(fixtures["truncated"])?;
    match read_frame(&mut Cursor::new(encoded), DEFAULT_MAX_FRAME_BYTES) {
        Err(_) => Ok(()),
        Ok(_) => Err("truncated fixture was accepted".to_owned()),
    }
}
