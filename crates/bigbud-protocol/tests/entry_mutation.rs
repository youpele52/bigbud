//! `workspace.mkdir` and `workspace.delete` 1.0 frames shared with the TypeScript codec.
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
    use v1::frame::Payload::{
        CreateDirectoryRequest, CreateDirectoryResponse, DeleteEntryRequest, DeleteEntryResponse,
    };
    vec![
        (
            "create_directory_request",
            CreateDirectoryRequest(v1::CreateDirectoryRequest {
                request_id: "mkdir-1".to_owned(),
                operation_id: "entry-operation-1".to_owned(),
                request_digest: vec![1, 2],
                workspace_handle: "workspace-1".to_owned(),
                path: "src/new".to_owned(),
            }),
        ),
        (
            "create_directory_response_exists",
            CreateDirectoryResponse(v1::CreateDirectoryResponse {
                request_id: "mkdir-1".to_owned(),
                operation_id: "entry-operation-1".to_owned(),
                terminal: true,
                error_code: "ALREADY_EXISTS".to_owned(),
                error_message: "workspace file already exists".to_owned(),
            }),
        ),
        (
            "delete_entry_request",
            DeleteEntryRequest(v1::DeleteEntryRequest {
                request_id: "delete-1".to_owned(),
                operation_id: "entry-operation-2".to_owned(),
                request_digest: vec![3, 4],
                workspace_handle: "workspace-1".to_owned(),
                path: "src/old".to_owned(),
                expected_kind: "directory".to_owned(),
            }),
        ),
        (
            "delete_entry_response_deleted",
            DeleteEntryResponse(v1::DeleteEntryResponse {
                request_id: "delete-1".to_owned(),
                operation_id: "entry-operation-2".to_owned(),
                terminal: true,
                deleted_kind: "directory".to_owned(),
                ..Default::default()
            }),
        ),
    ]
}

#[test]
fn entry_mutation_frames_match_the_typescript_goldens() {
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
