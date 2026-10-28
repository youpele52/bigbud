use prost::Message;
use thiserror::Error;

use super::{CONTROL_FRAME_BYTES, DATA_FRAME_BYTES, v1, validate_frame};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Control,
    Data,
}

impl Channel {
    pub fn maximum(self) -> usize {
        match self {
            Self::Control => CONTROL_FRAME_BYTES,
            Self::Data => DATA_FRAME_BYTES,
        }
    }
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("invalid computer-use frame length")]
    Length,
    #[error("invalid computer-use message")]
    Invalid,
    #[error("computer-use message is on the wrong channel")]
    Channel,
    #[error("incompatible computer-use peer")]
    Incompatible,
    #[error("invalid computer-use protobuf: {0}")]
    Decode(#[from] prost::DecodeError),
    #[error("failed to encode computer-use protobuf: {0}")]
    Encode(#[from] prost::EncodeError),
}

/// The caller must reserve aggregate ingress credit before reading a payload.
/// This complete-frame codec neither blocks on I/O nor allocates from an
/// unchecked prefix. Transport must enforce the independent 5s frame deadline.
pub fn decode_frame(bytes: &[u8], channel: Channel) -> Result<v1::Frame, FrameError> {
    let prefix: [u8; 4] = bytes
        .get(..4)
        .ok_or(FrameError::Length)?
        .try_into()
        .map_err(|_| FrameError::Length)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > channel.maximum() || bytes.len() != length + 4 {
        return Err(FrameError::Length);
    }
    let payload = bytes.get(4..).ok_or(FrameError::Length)?;
    super::wire::validate(payload)?;
    let frame = v1::Frame::decode(payload)?;
    validate_frame(&frame, channel)?;
    Ok(frame)
}

pub fn encode_frame(frame: &v1::Frame, channel: Channel) -> Result<Vec<u8>, FrameError> {
    validate_frame(frame, channel)?;
    let length = frame.encoded_len();
    if length == 0 || length > channel.maximum() {
        return Err(FrameError::Length);
    }
    let prefix = u32::try_from(length).map_err(|_| FrameError::Length)?;
    let mut bytes = Vec::with_capacity(length + 4);
    bytes.extend_from_slice(&prefix.to_be_bytes());
    frame.encode(&mut bytes)?;
    Ok(bytes)
}
