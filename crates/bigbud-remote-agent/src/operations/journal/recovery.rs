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
        let encoded_length = <[u8; 4]>::try_from(
            bytes
                .get(cursor..cursor + 4)
                .ok_or(OperationJournalError::Corrupt("invalid record length"))?,
        )
        .map_err(|_| OperationJournalError::Corrupt("invalid record length"))?;
        let length = usize::try_from(u32::from_be_bytes(encoded_length))
            .map_err(|_| OperationJournalError::Corrupt("record length overflow"))?;
        cursor += 4;
        if length == 0 || length > MAX_FIELD_BYTES {
            return Err(OperationJournalError::Corrupt("invalid record length"));
        }
        if bytes.len() - cursor < length {
            return Ok((records, record_start));
        }
        let record = bytes
            .get(cursor..cursor + length)
            .ok_or(OperationJournalError::Corrupt("invalid record length"))?;
        records.push(decode_record(record)?);
        cursor += length;
    }
    Ok((records, cursor))
}
