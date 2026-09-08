use super::*;

pub(super) fn restore_process_journal(
    registry: &mut OperationRegistry,
    records: Vec<JournalRecord>,
    now: Instant,
) -> Result<(), SessionError> {
    let current_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionError::ProcessJournal("clock is before Unix epoch".to_owned()))?
        .as_millis() as u64;
    let mut latest_retention = HashMap::new();
    for record in &records {
        if let JournalRecord::Retention {
            operation_id,
            expires_at_unix_ms,
        } = record
        {
            latest_retention.insert(operation_id.clone(), *expires_at_unix_ms);
        }
    }

    for record in records {
        if matches!(record, JournalRecord::Retention { .. }) {
            continue;
        }
        if latest_retention
            .get(operation_id(&record))
            .is_some_and(|expires_at| *expires_at <= current_unix_ms)
        {
            continue;
        }
        registry
            .restore_journal_record(record, now)
            .map_err(|error| SessionError::ProcessJournal(error.to_string()))?;
    }
    for (operation_id, expires_at_unix_ms) in latest_retention {
        if expires_at_unix_ms <= current_unix_ms {
            continue;
        }
        registry
            .restore_journal_record(
                JournalRecord::Retention {
                    operation_id,
                    expires_at_unix_ms,
                },
                now,
            )
            .map_err(|error| SessionError::ProcessJournal(error.to_string()))?;
    }
    Ok(())
}

fn operation_id(record: &JournalRecord) -> &str {
    match record {
        JournalRecord::Accepted { operation_id, .. }
        | JournalRecord::Started { operation_id }
        | JournalRecord::Output { operation_id, .. }
        | JournalRecord::Acknowledged { operation_id, .. }
        | JournalRecord::OutputWatermark { operation_id, .. }
        | JournalRecord::Retention { operation_id, .. }
        | JournalRecord::Completed { operation_id, .. } => operation_id,
    }
}
