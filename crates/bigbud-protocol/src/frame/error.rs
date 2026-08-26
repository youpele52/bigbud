use std::io;

use thiserror::Error;

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
