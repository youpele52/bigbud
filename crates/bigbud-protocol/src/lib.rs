use std::io::{self, Read, Write};

use prost::Message;
use thiserror::Error;

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.remote_agent.v1.rs"));
}

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 1;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("failed to read frame length: {0}")]
    ReadLength(#[source] io::Error),
    #[error("failed to read frame payload: {0}")]
    ReadPayload(#[source] io::Error),
    #[error("failed to write frame: {0}")]
    Write(#[source] io::Error),
    #[error("frame length {actual} exceeds maximum {maximum}")]
    Oversized { actual: usize, maximum: usize },
    #[error("protobuf frame is invalid: {0}")]
    Decode(#[source] prost::DecodeError),
    #[error("protobuf frame is too large: {0}")]
    Encode(#[source] prost::EncodeError),
}

/// Encodes a protobuf message with a four-byte big-endian length prefix.
pub fn encode_frame(frame: &v1::Frame, maximum: usize) -> Result<Vec<u8>, FrameError> {
    let payload = frame.encode_to_vec();
    if payload.len() > maximum {
        return Err(FrameError::Oversized {
            actual: payload.len(),
            maximum,
        });
    }

    let length = u32::try_from(payload.len()).map_err(|_| FrameError::Oversized {
        actual: payload.len(),
        maximum,
    })?;
    let mut encoded = Vec::with_capacity(payload.len() + 4);
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_frame(encoded: &[u8], maximum: usize) -> Result<v1::Frame, FrameError> {
    if encoded.len() < 4 {
        return Err(FrameError::Oversized {
            actual: encoded.len(),
            maximum: 4,
        });
    }

    let length = u32::from_be_bytes([encoded[0], encoded[1], encoded[2], encoded[3]]) as usize;
    if length > maximum {
        return Err(FrameError::Oversized {
            actual: length,
            maximum,
        });
    }
    if encoded.len() != length + 4 {
        return Err(FrameError::ReadPayload(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "frame payload length does not match prefix",
        )));
    }

    v1::Frame::decode(&encoded[4..]).map_err(FrameError::Decode)
}

pub fn read_frame<R: Read>(
    reader: &mut R,
    maximum: usize,
) -> Result<Option<v1::Frame>, FrameError> {
    let mut length_bytes = [0; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(FrameError::ReadLength(error)),
    }

    let length = u32::from_be_bytes(length_bytes) as usize;
    if length > maximum {
        return Err(FrameError::Oversized {
            actual: length,
            maximum,
        });
    }

    let mut payload = vec![0; length];
    reader
        .read_exact(&mut payload)
        .map_err(FrameError::ReadPayload)?;
    v1::Frame::decode(payload.as_slice())
        .map(Some)
        .map_err(FrameError::Decode)
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    frame: &v1::Frame,
    maximum: usize,
) -> Result<(), FrameError> {
    let encoded = encode_frame(frame, maximum)?;
    writer.write_all(&encoded).map_err(FrameError::Write)?;
    writer.flush().map_err(FrameError::Write)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::v1::{
        AgentHello, CancelRequest, CancelResponse, Capability, ClientHello, DiagnosticRequest,
        DiagnosticResponse, Frame, frame,
    };
    use super::*;

    fn hello_frame() -> Frame {
        Frame {
            payload: Some(frame::Payload::ClientHello(ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "client-1".to_owned(),
                connection_id: "connection-1".to_owned(),
                server_nonce: "nonce".to_owned(),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            })),
        }
    }

    fn golden_frame(name: &str) -> Vec<u8> {
        include_str!("../../../protocol/remote-agent/v1.golden.frames")
            .lines()
            .find_map(|line| {
                let (line_name, hex) = line.split_once('=')?;
                (line_name == name).then(|| {
                    hex.as_bytes()
                        .chunks_exact(2)
                        .map(|pair| {
                            u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
                        })
                        .collect()
                })
            })
            .expect("golden frame exists")
    }

    fn assert_golden(name: &str, frame: Frame) {
        let golden = golden_frame(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            golden
        );
        assert_eq!(
            decode_frame(&golden, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame
        );
    }

    #[test]
    fn matches_typescript_golden_frames() {
        assert_golden("client_hello", hello_frame());
        assert_golden(
            "agent_hello",
            Frame {
                payload: Some(frame::Payload::AgentHello(AgentHello {
                    protocol_major: 1,
                    protocol_minor: PROTOCOL_MINOR,
                    agent_version: "0.1.0".to_owned(),
                    build_digest: "development".to_owned(),
                    os: "linux".to_owned(),
                    architecture: "x86_64".to_owned(),
                    agent_instance_id: "agent-1".to_owned(),
                    agent_epoch: "epoch-1".to_owned(),
                    capabilities: vec![Capability {
                        name: "diagnostic".to_owned(),
                        major: 1,
                        minor: 0,
                    }],
                    max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
                    max_operation_output_bytes: 0,
                    max_journal_bytes: 0,
                })),
            },
        );
        assert_golden(
            "diagnostic_request",
            Frame {
                payload: Some(frame::Payload::DiagnosticRequest(DiagnosticRequest {
                    request_id: "request-1".to_owned(),
                    operation_id: "operation-1".to_owned(),
                    request_digest: vec![1, 2, 3],
                    workspace_handle: "workspace-1".to_owned(),
                    deadline_unix_ms: 123,
                    kind: "diagnostic".to_owned(),
                })),
            },
        );
        assert_golden(
            "diagnostic_response",
            Frame {
                payload: Some(frame::Payload::DiagnosticResponse(DiagnosticResponse {
                    request_id: "request-1".to_owned(),
                    operation_id: "operation-1".to_owned(),
                    accepted: true,
                    terminal: true,
                    message: "agent-ready".to_owned(),
                })),
            },
        );
        assert_golden(
            "cancel_request",
            Frame {
                payload: Some(frame::Payload::CancelRequest(CancelRequest {
                    request_id: "request-2".to_owned(),
                    operation_id: "operation-1".to_owned(),
                })),
            },
        );
        assert_golden(
            "cancel_response",
            Frame {
                payload: Some(frame::Payload::CancelResponse(CancelResponse {
                    request_id: "request-2".to_owned(),
                    operation_id: "operation-1".to_owned(),
                    cancelled: false,
                    terminal: true,
                    detail: "operation-already-terminal".to_owned(),
                })),
            },
        );
        assert_golden(
            "workspace_watch_start_request",
            Frame {
                payload: Some(frame::Payload::WorkspaceWatchStartRequest(
                    v1::WorkspaceWatchStartRequest {
                        request_id: "watch-start".to_owned(),
                        subscription_id: "watch-1".to_owned(),
                        workspace_handle: "workspace-1".to_owned(),
                        path: "docs".to_owned(),
                    },
                )),
            },
        );
        assert_golden(
            "workspace_watch_start_response",
            Frame {
                payload: Some(frame::Payload::WorkspaceWatchStartResponse(
                    v1::WorkspaceWatchStartResponse {
                        request_id: "watch-start".to_owned(),
                        subscription_id: "watch-1".to_owned(),
                        accepted: true,
                        generation: 4,
                        backend: "native".to_owned(),
                        error_code: String::new(),
                        error_message: String::new(),
                    },
                )),
            },
        );
        assert_golden(
            "workspace_watch_event",
            Frame {
                payload: Some(frame::Payload::WorkspaceWatchEvent(
                    v1::WorkspaceWatchEvent {
                        subscription_id: "watch-1".to_owned(),
                        generation: 4,
                        sequence: 2,
                        changes: vec![v1::WorkspaceChange {
                            path: "docs/README.md".to_owned(),
                            kind: "modify".to_owned(),
                        }],
                        rescan_required: false,
                        rescan_reason: String::new(),
                        backend: "native".to_owned(),
                    },
                )),
            },
        );
        assert_golden(
            "workspace_watch_stop_request",
            Frame {
                payload: Some(frame::Payload::WorkspaceWatchStopRequest(
                    v1::WorkspaceWatchStopRequest {
                        request_id: "watch-stop".to_owned(),
                        subscription_id: "watch-1".to_owned(),
                    },
                )),
            },
        );
        assert_golden(
            "workspace_watch_stop_response",
            Frame {
                payload: Some(frame::Payload::WorkspaceWatchStopResponse(
                    v1::WorkspaceWatchStopResponse {
                        request_id: "watch-stop".to_owned(),
                        subscription_id: "watch-1".to_owned(),
                        stopped: true,
                    },
                )),
            },
        );
    }

    #[test]
    fn round_trips_a_length_prefixed_frame() {
        let encoded = encode_frame(&hello_frame(), DEFAULT_MAX_FRAME_BYTES).unwrap();
        let decoded = decode_frame(&encoded, DEFAULT_MAX_FRAME_BYTES).unwrap();
        assert_eq!(decoded, hello_frame());

        let mut reader = Cursor::new(encoded);
        assert_eq!(
            read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            Some(decoded)
        );
        assert_eq!(
            read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            None
        );
    }

    #[test]
    fn rejects_oversized_frames_before_allocating_payload() {
        let encoded = [0, 16, 0, 0];
        let error = decode_frame(&encoded, 8).unwrap_err();
        assert!(matches!(
            error,
            FrameError::Oversized {
                actual: 1_048_576,
                maximum: 8
            }
        ));
    }

    #[test]
    fn rejects_mismatched_payload_lengths() {
        let encoded = [0, 0, 0, 5, 1, 2];
        let error = decode_frame(&encoded, DEFAULT_MAX_FRAME_BYTES).unwrap_err();
        assert!(matches!(error, FrameError::ReadPayload(_)));
    }
}
