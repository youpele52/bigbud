use super::*;

#[derive(Default)]
pub(super) struct CompactOperation {
    pub(super) request_digest: Option<Vec<u8>>,
    pub(super) started: bool,
    pub(super) outputs: Vec<(u64, OutputStream, Vec<u8>)>,
    pub(super) acknowledged_sequence: u64,
    pub(super) next_sequence: u64,
    pub(super) first_retained_sequence: u64,
    pub(super) expires_at_unix_ms: Option<u64>,
    pub(super) completed: Option<(OperationState, Option<i32>, Option<String>)>,
}

pub(super) fn append_encoded(
    output: &mut Vec<Vec<u8>>,
    record: &JournalRecord,
) -> Result<(), OperationJournalError> {
    let encoded = encode_record(record)?;
    output.push((encoded.len() as u32).to_be_bytes().into());
    output.push(encoded);
    Ok(())
}

pub(super) fn encode_record(record: &JournalRecord) -> Result<Vec<u8>, OperationJournalError> {
    let mut output = Vec::new();
    match record {
        JournalRecord::Accepted {
            operation_id,
            request_digest,
        } => {
            output.push(1);
            write_string(&mut output, operation_id)?;
            write_bytes(&mut output, request_digest)?;
        }
        JournalRecord::Started { operation_id } => {
            output.push(2);
            write_string(&mut output, operation_id)?;
        }
        JournalRecord::Output {
            operation_id,
            sequence,
            stream,
            bytes,
        } => {
            output.push(3);
            write_string(&mut output, operation_id)?;
            output.extend_from_slice(&sequence.to_be_bytes());
            output.push(match stream {
                OutputStream::Stdout => 1,
                OutputStream::Stderr => 2,
            });
            write_bytes(&mut output, bytes)?;
        }
        JournalRecord::Acknowledged {
            operation_id,
            acknowledged_sequence,
        } => {
            output.push(4);
            write_string(&mut output, operation_id)?;
            output.extend_from_slice(&acknowledged_sequence.to_be_bytes());
        }
        JournalRecord::OutputWatermark {
            operation_id,
            next_sequence,
            first_retained_sequence,
        } => {
            output.push(6);
            write_string(&mut output, operation_id)?;
            output.extend_from_slice(&next_sequence.to_be_bytes());
            output.extend_from_slice(&first_retained_sequence.to_be_bytes());
        }
        JournalRecord::Retention {
            operation_id,
            expires_at_unix_ms,
        } => {
            output.push(7);
            write_string(&mut output, operation_id)?;
            output.extend_from_slice(&expires_at_unix_ms.to_be_bytes());
        }
        JournalRecord::Completed {
            operation_id,
            state,
            exit_code,
            error_code,
        } => {
            output.push(5);
            write_string(&mut output, operation_id)?;
            output.push(encode_state(*state));
            match exit_code {
                Some(code) => {
                    output.push(1);
                    output.extend_from_slice(&code.to_be_bytes());
                }
                None => output.push(0),
            }
            match error_code {
                Some(value) => {
                    output.push(1);
                    write_string(&mut output, value)?;
                }
                None => output.push(0),
            }
        }
    }
    if output.len() > MAX_FIELD_BYTES {
        return Err(OperationJournalError::RecordTooLarge);
    }
    Ok(output)
}

pub(super) fn decode_record(bytes: &[u8]) -> Result<JournalRecord, OperationJournalError> {
    let mut cursor = Cursor::new(bytes);
    let tag = cursor.byte()?;
    let record = match tag {
        1 => JournalRecord::Accepted {
            operation_id: cursor.string()?,
            request_digest: cursor.bytes()?,
        },
        2 => JournalRecord::Started {
            operation_id: cursor.string()?,
        },
        3 => JournalRecord::Output {
            operation_id: cursor.string()?,
            sequence: cursor.u64()?,
            stream: match cursor.byte()? {
                1 => OutputStream::Stdout,
                2 => OutputStream::Stderr,
                _ => return Err(OperationJournalError::Corrupt("invalid output stream")),
            },
            bytes: cursor.bytes()?,
        },
        4 => JournalRecord::Acknowledged {
            operation_id: cursor.string()?,
            acknowledged_sequence: cursor.u64()?,
        },
        6 => JournalRecord::OutputWatermark {
            operation_id: cursor.string()?,
            next_sequence: cursor.u64()?,
            first_retained_sequence: cursor.u64()?,
        },
        7 => JournalRecord::Retention {
            operation_id: cursor.string()?,
            expires_at_unix_ms: cursor.u64()?,
        },
        5 => JournalRecord::Completed {
            operation_id: cursor.string()?,
            state: decode_state(cursor.byte()?)?,
            exit_code: if cursor.byte()? == 1 {
                Some(cursor.i32()?)
            } else {
                None
            },
            error_code: if cursor.byte()? == 1 {
                Some(cursor.string()?)
            } else {
                None
            },
        },
        _ => return Err(OperationJournalError::Corrupt("unknown record type")),
    };
    if cursor.remaining() != 0 {
        return Err(OperationJournalError::Corrupt("trailing record bytes"));
    }
    Ok(record)
}

fn write_string(output: &mut Vec<u8>, value: &str) -> Result<(), OperationJournalError> {
    write_bytes(output, value.as_bytes())
}

fn write_bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), OperationJournalError> {
    let length = u32::try_from(value.len()).map_err(|_| OperationJournalError::RecordTooLarge)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn encode_state(state: OperationState) -> u8 {
    match state {
        OperationState::Accepted => 1,
        OperationState::Running => 2,
        OperationState::Cancelling => 3,
        OperationState::Completed => 4,
        OperationState::Cancelled => 5,
        OperationState::Failed => 6,
        OperationState::Expired => 7,
    }
}

fn decode_state(value: u8) -> Result<OperationState, OperationJournalError> {
    match value {
        1 => Ok(OperationState::Accepted),
        2 => Ok(OperationState::Running),
        3 => Ok(OperationState::Cancelling),
        4 => Ok(OperationState::Completed),
        5 => Ok(OperationState::Cancelled),
        6 => Ok(OperationState::Failed),
        7 => Ok(OperationState::Expired),
        _ => Err(OperationJournalError::Corrupt("invalid operation state")),
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn byte(&mut self) -> Result<u8, OperationJournalError> {
        let byte = *self
            .bytes
            .get(self.offset)
            .ok_or(OperationJournalError::Corrupt("truncated field"))?;
        self.offset += 1;
        Ok(byte)
    }

    fn u64(&mut self) -> Result<u64, OperationJournalError> {
        let bytes = self.take(8)?;
        Ok(u64::from_be_bytes(bytes.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, OperationJournalError> {
        let bytes = self.take(4)?;
        Ok(i32::from_be_bytes(bytes.try_into().unwrap()))
    }

    fn bytes(&mut self) -> Result<Vec<u8>, OperationJournalError> {
        let length = u32::from_be_bytes(self.take(4)?.try_into().unwrap()) as usize;
        if length > MAX_FIELD_BYTES {
            return Err(OperationJournalError::Corrupt("field exceeds maximum"));
        }
        Ok(self.take(length)?.to_vec())
    }

    fn string(&mut self) -> Result<String, OperationJournalError> {
        String::from_utf8(self.bytes()?)
            .map_err(|_| OperationJournalError::Corrupt("field is not UTF-8"))
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], OperationJournalError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(OperationJournalError::Corrupt("field length overflow"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(OperationJournalError::Corrupt("truncated field"))?;
        self.offset = end;
        Ok(value)
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }
}

pub(super) fn set_private_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
