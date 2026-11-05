//! Strict flat protobuf shape before prost allocation. All current computer-use
//! messages are scalar-only, with one envelope level; unknown/duplicate fields
//! are refused in both codecs. Extend the schema and both codecs together.
use super::FrameError;

fn uint(bytes: &[u8], offset: &mut usize) -> Result<u64, FrameError> {
    let mut value = 0_u64;
    for shift in (0..=63).step_by(7) {
        let byte = *bytes.get(*offset).ok_or(FrameError::Invalid)?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err(FrameError::Invalid);
        }
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(FrameError::Invalid)
}
fn take<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8], FrameError> {
    let length = usize::try_from(uint(bytes, offset)?).map_err(|_| FrameError::Invalid)?;
    let end = offset.checked_add(length).ok_or(FrameError::Invalid)?;
    let value = bytes.get(*offset..end).ok_or(FrameError::Invalid)?;
    *offset = end;
    Ok(value)
}

pub(super) fn validate(bytes: &[u8]) -> Result<(), FrameError> {
    let mut offset = 0;
    let tag = uint(bytes, &mut offset)?;
    if tag & 7 != 2 {
        return Err(FrameError::Invalid);
    }
    let kind = tag >> 3;
    let maximum_field = match kind {
        1 => 10,
        2 => 6,
        3 | 4 => 5,
        5 => 16,
        6 | 7 => 3,
        8 => 2,
        9 => 3,
        10 | 11 => 6,
        12 => 4,
        13 => 10,
        14 => 5,
        15..=17 => 3,
        18 => 2,
        _ => return Err(FrameError::Invalid),
    };
    let payload = take(bytes, &mut offset)?;
    if offset != bytes.len() {
        return Err(FrameError::Invalid);
    }
    let mut field_offset = 0;
    let mut seen = 0_u32;
    while field_offset < payload.len() {
        let tag = uint(payload, &mut field_offset)?;
        let field = tag >> 3;
        if field == 0 || field > maximum_field {
            return Err(FrameError::Invalid);
        }
        let mask = 1_u32 << field;
        if seen & mask != 0 {
            return Err(FrameError::Invalid);
        }
        seen |= mask;
        // Prost deliberately narrows uint64 varints with `as u32` for uint32
        // fields. Reject overflow BEFORE prost can truncate a version/limit.
        let numeric_maximum = match (kind, field) {
            (1, 1 | 2 | 8 | 9) | (5, 12) | (7, 2) | (13, 10) => Some(u64::from(u32::MAX)),
            (5, 6 | 15) | (9 | 10, 2) | (13, 3) => Some(u64::MAX),
            _ => None,
        };
        match (tag & 7, numeric_maximum) {
            (0, Some(maximum)) => {
                if uint(payload, &mut field_offset)? > maximum {
                    return Err(FrameError::Invalid);
                }
            }
            (2, None) => {
                take(payload, &mut field_offset)?;
            }
            _ => return Err(FrameError::Invalid),
        }
    }
    Ok(())
}
