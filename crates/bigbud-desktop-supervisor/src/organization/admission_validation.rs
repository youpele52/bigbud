use prost::Message;

pub use super::admission_wire::valid_envelope;
use super::protocol::{facts::v1::ThreadFacts, policy::v1::Limits};

pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_SAFE_UINT: u64 = 9_007_199_254_740_991;

pub fn valid_limits(limits: &Limits) -> bool {
    [
        (limits.frame_bytes, MAX_FRAME_BYTES as u32),
        (limits.page_rows, 256),
        (limits.live_rows, 100_000),
        (limits.state_bytes, 64 * 1024 * 1024),
        (limits.pending_facts, 2_000),
        (limits.pending_bytes, 8 * 1024 * 1024),
    ]
    .into_iter()
    .all(|(value, maximum)| value > 0 && value <= maximum)
}

pub fn valid_row(row: &ThreadFacts) -> bool {
    !row.thread_id.is_empty()
        && row.thread_id.len() <= 256
        && row.snooze_identity.len() <= 256
        && row.fact_version > 0
        && row
            .manual_attention_watermark
            .is_none_or(|watermark| watermark <= row.attention_watermark)
        && (1..=4).contains(&row.section)
        && (1..=3).contains(&row.work)
        && row.snooze_until_ms.is_some() != row.snooze_identity.is_empty()
        && [
            Some(row.fact_version),
            Some(row.organization_revision),
            Some(row.attention_watermark),
            row.inactivity_at_ms,
            row.manual_until_ms,
            row.snooze_until_ms,
            row.grace_until_ms,
            row.manual_attention_watermark,
            row.engaged_until_ms,
        ]
        .into_iter()
        .flatten()
        .all(|value| value <= MAX_SAFE_UINT)
}

pub fn row_bytes(row: &ThreadFacts) -> usize {
    row.encoded_len() + 4
}

#[cfg(test)]
#[path = "admission_validation_tests.rs"]
mod tests;
