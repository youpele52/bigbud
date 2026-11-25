use std::{fmt, io};

const CLIENT_TO_OWNER_MAX: usize = 64 * 1024;
const OWNER_TO_CLIENT_MAX: usize = 8 * 1024 * 1024;

/// The trusted local role, chosen independently of the received payload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Endpoint {
    Client,
    Owner,
}

impl Endpoint {
    pub fn inbound_max(self) -> usize {
        match self {
            Self::Client => OWNER_TO_CLIENT_MAX,
            Self::Owner => CLIENT_TO_OWNER_MAX,
        }
    }

    pub fn outbound_max(self) -> usize {
        match self {
            Self::Client => CLIENT_TO_OWNER_MAX,
            Self::Owner => OWNER_TO_CLIENT_MAX,
        }
    }

    /// Validates a complete prefix and returns the payload length, excluding the prefix.
    pub fn decode_inbound_header(self, header: [u8; 4]) -> Result<usize, FrameError> {
        let length = u32::from_be_bytes(header) as usize;
        validate_length(length, self.inbound_max())?;
        Ok(length)
    }

    /// Reads one opaque payload; `None` is EOF before any header byte.
    ///
    /// An incomplete header or body is an error, not a clean EOF. Treat any
    /// error as terminal for the stream; framing does not attempt resynchronization.
    pub fn read_frame(self, reader: &mut impl io::Read) -> Result<Option<Vec<u8>>, FrameError> {
        let mut header = [0; 4];
        let received = loop {
            match reader.read(&mut header) {
                Ok(0) => return Ok(None),
                Ok(received) => break received,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(FrameError::ReadHeader(error)),
            }
        };
        let remaining = header.get_mut(received..).ok_or_else(|| {
            FrameError::ReadHeader(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid read count",
            ))
        })?;
        reader
            .read_exact(remaining)
            .map_err(FrameError::ReadHeader)?;
        let length = self.decode_inbound_header(header)?;

        let mut payload = vec![0; length];
        reader
            .read_exact(&mut payload)
            .map_err(FrameError::ReadPayload)?;
        Ok(Some(payload))
    }

    /// Writes an opaque payload and its prefix without flushing the writer.
    ///
    /// Invalid lengths write nothing. An I/O error may leave a partial frame.
    pub fn write_frame(
        self,
        writer: &mut impl io::Write,
        payload: &[u8],
    ) -> Result<(), FrameError> {
        let length = payload.len();
        validate_length(length, self.outbound_max())?;
        // Both directional limits fit in u32, and length has been checked above.
        writer
            .write_all(&(length as u32).to_be_bytes())
            .map_err(FrameError::Write)?;
        writer.write_all(payload).map_err(FrameError::Write)
    }
}

fn validate_length(length: usize, maximum: usize) -> Result<(), FrameError> {
    if length == 0 {
        return Err(FrameError::Empty);
    }
    if length > maximum {
        return Err(FrameError::Oversized {
            actual: length,
            maximum,
        });
    }
    Ok(())
}

#[derive(Debug)]
pub enum FrameError {
    Empty,
    Oversized { actual: usize, maximum: usize },
    ReadHeader(io::Error),
    ReadPayload(io::Error),
    Write(io::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("empty SSH-owner frame payload"),
            Self::Oversized { actual, maximum } => {
                write!(
                    f,
                    "SSH-owner frame payload is {actual} bytes; maximum is {maximum}"
                )
            }
            Self::ReadHeader(error) => write!(f, "failed to read SSH-owner frame header: {error}"),
            Self::ReadPayload(error) => {
                write!(f, "failed to read SSH-owner frame payload: {error}")
            }
            Self::Write(error) => write!(f, "failed to write SSH-owner frame: {error}"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ReadHeader(error) | Self::ReadPayload(error) | Self::Write(error) => Some(error),
            Self::Empty | Self::Oversized { .. } => None,
        }
    }
}
