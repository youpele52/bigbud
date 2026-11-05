use bigbud_protocol::computer_use::{
    CONTROL_FRAME_BYTES, Channel, FrameError, decode_frame, encode_frame, v1,
};
use std::io::{self, Read, Write};

#[derive(Debug)]
pub(crate) enum ReadOutcome {
    Frame(Box<v1::Frame>),
    /// Clean EOF exactly at a frame boundary: the lifeline closed.
    Closed,
}

#[derive(Debug)]
pub(crate) enum ControlReadError {
    /// EOF inside a frame: the stream lost framing.
    Truncated,
    Io,
    Frame(FrameError),
}

/// Reads one complete control frame. The length is checked against the
/// control bound before any payload allocation. `on_start` runs once, when
/// the first byte of a frame arrives (it starts the per-frame deadline).
pub(crate) fn read_frame(
    reader: &mut impl Read,
    on_start: impl FnOnce(),
) -> Result<ReadOutcome, ControlReadError> {
    let mut on_start = Some(on_start);
    let mut prefix = [0_u8; 4];
    let mut filled = 0;
    while let Some(rest) = prefix.get_mut(filled..).filter(|rest| !rest.is_empty()) {
        match reader.read(rest) {
            Ok(0) if filled == 0 => return Ok(ReadOutcome::Closed),
            Ok(0) => return Err(ControlReadError::Truncated),
            Ok(read) => {
                if let Some(start) = on_start.take() {
                    start();
                }
                filled += read;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ControlReadError::Io),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > CONTROL_FRAME_BYTES {
        return Err(ControlReadError::Frame(FrameError::Length));
    }
    let mut bytes = Vec::with_capacity(length + prefix.len());
    bytes.extend_from_slice(&prefix);
    reader
        .take(length as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ControlReadError::Io)?;
    if bytes.len() != length + prefix.len() {
        return Err(ControlReadError::Truncated);
    }
    decode_frame(&bytes, Channel::Control)
        .map(|frame| ReadOutcome::Frame(Box::new(frame)))
        .map_err(ControlReadError::Frame)
}

pub(crate) fn write_frame(writer: &mut impl Write, frame: &v1::Frame) -> io::Result<()> {
    let bytes = encode_frame(frame, Channel::Control)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&bytes)?;
    writer.flush()
}
