use std::collections::HashMap;

use super::{JournalRecord, OperationJournalError};

#[derive(Default)]
struct History {
    started: bool,
    completed: bool,
    last_output: u64,
    acknowledged: u64,
    watermark: Option<(u64, u64)>,
}

fn corrupt(message: &'static str) -> OperationJournalError {
    OperationJournalError::Corrupt(message)
}

fn validate_suffix(history: &History) -> Result<(), OperationJournalError> {
    if let Some((next, first)) = history.watermark {
        let restored_next = if history.last_output == 0 {
            first
        } else {
            history.last_output.saturating_add(1)
        };
        if restored_next < next {
            return Err(corrupt("incomplete compacted output suffix"));
        }
    }
    Ok(())
}

/// Validate record relationships; unmatched acceptances remain history, not a liveness decision.
pub(super) fn validate(records: &[JournalRecord]) -> Result<bool, OperationJournalError> {
    let mut operations = HashMap::<&str, History>::new();
    for record in records {
        if let JournalRecord::Accepted {
            operation_id,
            request_digest,
        } = record
        {
            if operation_id.is_empty() || request_digest.is_empty() {
                return Err(corrupt("incomplete acceptance identity"));
            }
            if operations
                .get(operation_id.as_str())
                .is_some_and(|history| !history.completed)
            {
                return Err(corrupt("duplicate accepted operation"));
            }
            operations.insert(operation_id, History::default());
            continue;
        }
        let operation_id = match record {
            JournalRecord::Accepted { operation_id, .. }
            | JournalRecord::Started { operation_id }
            | JournalRecord::Output { operation_id, .. }
            | JournalRecord::Acknowledged { operation_id, .. }
            | JournalRecord::OutputWatermark { operation_id, .. }
            | JournalRecord::Retention { operation_id, .. }
            | JournalRecord::Completed { operation_id, .. } => operation_id,
        };
        let history = operations
            .get_mut(operation_id.as_str())
            .ok_or_else(|| corrupt("record has no preceding acceptance"))?;
        match record {
            JournalRecord::Started { .. } => {
                if history.started || history.completed {
                    return Err(corrupt("invalid started operation"));
                }
                history.started = true;
            }
            JournalRecord::Output { sequence, .. } => {
                let expected = if history.last_output == 0 {
                    history.watermark.map_or(1, |(_, first)| first)
                } else {
                    history.last_output.saturating_add(1)
                };
                if !history.started
                    || history.completed
                    || *sequence == 0
                    || *sequence == u64::MAX
                    || *sequence != expected
                {
                    return Err(corrupt("invalid output sequence or operation state"));
                }
                history.last_output = *sequence;
            }
            JournalRecord::Acknowledged {
                acknowledged_sequence,
                ..
            } => {
                let next = if history.last_output == 0 {
                    history.watermark.map_or(1, |(_, first)| first)
                } else {
                    history.last_output.saturating_add(1)
                };
                if *acknowledged_sequence < history.acknowledged || *acknowledged_sequence >= next {
                    return Err(corrupt("invalid output acknowledgement"));
                }
                history.acknowledged = *acknowledged_sequence;
            }
            JournalRecord::OutputWatermark {
                next_sequence,
                first_retained_sequence,
                ..
            } => {
                if history.watermark.is_some()
                    || history.last_output != 0
                    || *first_retained_sequence == 0
                    || *first_retained_sequence > *next_sequence
                {
                    return Err(corrupt("invalid output watermark"));
                }
                history.watermark = Some((*next_sequence, *first_retained_sequence));
            }
            JournalRecord::Completed { state, .. } => {
                if history.completed || !state.is_terminal() {
                    return Err(corrupt("invalid completed operation"));
                }
                validate_suffix(history)?;
                history.completed = true;
            }
            JournalRecord::Retention { .. } => {}
            JournalRecord::Accepted { .. } => {
                return Err(corrupt(
                    "acceptance was not handled before dependent records",
                ));
            }
        }
    }
    for history in operations.values() {
        validate_suffix(history)?;
    }
    Ok(operations.values().any(|history| !history.completed))
}
