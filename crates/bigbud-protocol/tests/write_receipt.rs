//! `workspace.write` 1.2 receipt frames shared with the TypeScript codec.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};

fn golden_frame(name: &str) -> Vec<u8> {
    let (_, hex) = include_str!("../../../protocol/remote-agent/v1.golden.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| *key == name)
        .expect("golden frame exists");
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn fixtures() -> Vec<(&'static str, v1::frame::Payload)> {
    use v1::frame::Payload::{WriteReceiptRequest, WriteReceiptResponse};
    vec![
        (
            "write_receipt_request",
            WriteReceiptRequest(v1::WriteReceiptRequest {
                request_id: "receipt-1".to_owned(),
                operation_id: "write-operation-1".to_owned(),
                request_digest: vec![5, 6],
            }),
        ),
        (
            "write_receipt_response_applied",
            WriteReceiptResponse(v1::WriteReceiptResponse {
                request_id: "receipt-1".to_owned(),
                operation_id: "write-operation-1".to_owned(),
                applied: true,
                result_sha256: "ab".repeat(32),
                ..Default::default()
            }),
        ),
        (
            "write_receipt_response_conflict",
            WriteReceiptResponse(v1::WriteReceiptResponse {
                request_id: "receipt-2".to_owned(),
                operation_id: "write-operation-1".to_owned(),
                error_code: "OPERATION_ID_CONFLICT".to_owned(),
                error_message: "operation id conflict".to_owned(),
                ..Default::default()
            }),
        ),
    ]
}

#[test]
fn write_receipt_frames_match_the_typescript_goldens() {
    for (name, payload) in fixtures() {
        let golden = golden_frame(name);
        let frame = v1::Frame {
            payload: Some(payload),
        };
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            golden,
            "{name}"
        );
        assert_eq!(
            decode_frame(&golden, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame,
            "{name}"
        );
    }
}
