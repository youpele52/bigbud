use crate::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};

fn golden(name: &str) -> Vec<u8> {
    let (_, hex) = include_str!("../../../../protocol/remote-agent/v1.golden.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| *key == name)
        .expect("shared paste staging golden exists");
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex byte")
        })
        .collect()
}

#[test]
fn paste_staging_frames_match_shared_typescript_goldens() {
    let frames = [
        (
            "paste_stage_begin_request",
            v1::frame::Payload::PasteStageBeginRequest(v1::PasteStageBeginRequest {
                request_id: "begin-1".to_owned(),
                scope: "0123456789abcdef0123456789abcdef".to_owned(),
                upload_id: "0123456789abcdef".to_owned(),
                total_bytes: 1_048_576,
                extension: "png".to_owned(),
                image_mime_type: "image/png".to_owned(),
            }),
        ),
        (
            "paste_stage_chunk_request",
            v1::frame::Payload::PasteStageChunkRequest(v1::PasteStageChunkRequest {
                request_id: "chunk-1".to_owned(),
                upload_id: "0123456789abcdef".to_owned(),
                offset: 524_288,
                data: vec![0x89, 0x50, 0x4e, 0x47],
            }),
        ),
        (
            "paste_stage_commit_response",
            v1::frame::Payload::PasteStageCommitResponse(v1::PasteStageCommitResponse {
                request_id: "commit-1".to_owned(),
                upload_id: "0123456789abcdef".to_owned(),
                path: "/home/dev/.bigbud/agent/paste/0123456789abcdef0123456789abcdef/paste-00.png"
                    .to_owned(),
                clipboard: "set".to_owned(),
                ..Default::default()
            }),
        ),
        (
            "paste_stage_discard_response",
            v1::frame::Payload::PasteStageDiscardResponse(v1::PasteStageDiscardResponse {
                request_id: "discard-1".to_owned(),
                removed: 2,
                ..Default::default()
            }),
        ),
    ];
    for (name, payload) in frames {
        let frame = v1::Frame {
            payload: Some(payload),
        };
        let bytes = golden(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            bytes,
            "{name}"
        );
        assert_eq!(
            decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame,
            "{name}"
        );
    }
}
