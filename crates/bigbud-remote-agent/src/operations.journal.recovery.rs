use super::*;

pub(super) fn decode_complete_records(
    bytes: &[u8],
) -> Result<(Vec<JournalRecord>, usize), OperationJournalError> {
    let mut cursor = MAGIC.len();
    let mut records = Vec::new();
    while cursor < bytes.len() {
        let record_start = cursor;
        if bytes.len() - cursor < 4 {
            return Ok((records, record_start));
        }
        let length = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        if length == 0 || length > MAX_FIELD_BYTES {
            return Err(OperationJournalError::Corrupt("invalid record length"));
        }
        if bytes.len() - cursor < length {
            return Ok((records, record_start));
        }
        records.push(decode_record(&bytes[cursor..cursor + length])?);
        cursor += length;
    }
    Ok((records, cursor))
}
