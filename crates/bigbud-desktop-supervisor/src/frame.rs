use std::io::{self, Read, Write};

use prost::Message;
use thiserror::Error;

use crate::v1;

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("failed to read frame length: {0}")]
    ReadLength(io::Error),
    #[error("failed to read frame payload: {0}")]
    ReadPayload(io::Error),
    #[error("failed to write frame: {0}")]
    Write(io::Error),
    #[error("frame length {actual} exceeds maximum {maximum}")]
    Oversized { actual: usize, maximum: usize },
    #[error("frame payload is empty")]
    Empty,
    #[error("protobuf frame is invalid: {0}")]
    Invalid(#[from] prost::DecodeError),
    #[error("protobuf frame is too large: {0}")]
    Length(#[from] std::num::TryFromIntError),
}

pub fn read_frame<R: Read>(
    reader: &mut R,
    maximum: usize,
) -> Result<Option<v1::Frame>, FrameError> {
    let mut length_bytes = [0; 4];
    loop {
        match reader.read(&mut length_bytes[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::ReadLength(error)),
        }
    }
    reader
        .read_exact(&mut length_bytes[1..])
        .map_err(FrameError::ReadLength)?;
    let length = u32::from_be_bytes(length_bytes) as usize;
    if length > maximum {
        return Err(FrameError::Oversized {
            actual: length,
            maximum,
        });
    }
    if length == 0 {
        return Err(FrameError::Empty);
    }
    let mut payload = vec![0; length];
    reader
        .read_exact(&mut payload)
        .map_err(FrameError::ReadPayload)?;
    Ok(Some(v1::Frame::decode(payload.as_slice())?))
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    frame: &v1::Frame,
    maximum: usize,
) -> Result<(), FrameError> {
    let payload = frame.encode_to_vec();
    if payload.is_empty() {
        return Err(FrameError::Empty);
    }
    if payload.len() > maximum {
        return Err(FrameError::Oversized {
            actual: payload.len(),
            maximum,
        });
    }
    let length = u32::try_from(payload.len())?;
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|()| writer.write_all(&payload))
        .map_err(FrameError::Write)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn round_trips_a_bounded_frame() {
        let frame = v1::Frame {
            payload: Some(v1::frame::Payload::Heartbeat(v1::Heartbeat {
                monotonic_millis: 42,
            })),
        };
        let mut encoded = Vec::new();
        assert!(write_frame(&mut encoded, &frame, 128).is_ok());
        let decoded = read_frame(&mut Cursor::new(encoded), 128);
        assert_eq!(decoded.ok(), Some(Some(frame)));
    }

    #[test]
    fn rejects_an_oversized_frame_before_payload_allocation() {
        let encoded = 129_u32.to_be_bytes();
        assert!(matches!(
            read_frame(&mut Cursor::new(encoded), 128),
            Err(FrameError::Oversized { .. })
        ));
    }

    #[test]
    fn rejects_an_empty_frame() {
        assert!(matches!(
            read_frame(&mut Cursor::new(0_u32.to_be_bytes()), 128),
            Err(FrameError::Empty)
        ));
    }

    #[test]
    fn rejects_a_partial_length_prefix_as_truncated_input() {
        assert!(matches!(
            read_frame(&mut Cursor::new([0, 0]), 128),
            Err(FrameError::ReadLength(error))
                if error.kind() == io::ErrorKind::UnexpectedEof
        ));
    }
}
