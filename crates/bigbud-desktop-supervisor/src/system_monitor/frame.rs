use crate::monitor_v1::Frame;
use prost::Message;
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 128 * 1024;

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid monitor frame size",
        ));
    }
    let mut data = vec![0u8; len];
    reader.read_exact(&mut data)?;
    let frame = Frame::decode(data.as_slice())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if frame.payload.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "empty monitor payload",
        ));
    }
    Ok(Some(frame))
}

pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let data = frame.encode_to_vec();
    if data.is_empty() || data.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid monitor output size",
        ));
    }
    let len = u32::try_from(data.len())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hello_matches_typescript_fixture() {
        let frame = Frame {
            payload: Some(crate::monitor_v1::frame::Payload::Hello(
                crate::monitor_v1::Hello { major: 1, minor: 1 },
            )),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &frame).expect("encode hello");
        assert_eq!(bytes, [0, 0, 0, 6, 10, 4, 8, 1, 16, 1]);
    }

    #[test]
    fn rejects_empty_oversized_partial_and_malformed() {
        for bytes in [
            vec![0, 0, 0, 0],
            vec![0, 2, 0, 1],
            vec![0, 0],
            vec![0, 0, 0, 1, 255],
        ] {
            assert!(read_frame(&mut bytes.as_slice()).is_err());
        }
    }
}
