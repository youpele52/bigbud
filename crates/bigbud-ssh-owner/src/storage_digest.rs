//! Canonical request-digest encoding for the private TypeScript SQLite adapter.

use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"bigbud.ssh_owner.v1/sqlite-transition\0";
// Reserve room for committing +1 as an exact integer on the TypeScript side.
const MAX_EXPECTED_SEQUENCE: u64 = (1 << 53) - 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesiredState {
    Connected,
    Disconnected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DigestError {
    TargetLengthOverflow,
    SequenceOutOfRange,
}

/// Computes the lowercase SHA-256 digest of an exact target, sequence and intent.
/// Writer epoch and request ID are verified separately by the SQLite transaction.
///
/// # Errors
///
/// Returns an error if the byte count cannot fit a `u32` or if advancing the
/// expected sequence would exceed TypeScript's exact integer range.
pub fn transition_digest(
    target: &str,
    expected_sequence: u64,
    desired: DesiredState,
) -> Result<String, DigestError> {
    if expected_sequence > MAX_EXPECTED_SEQUENCE {
        return Err(DigestError::SequenceOutOfRange);
    }
    let size = u32::try_from(target.len()).map_err(|_| DigestError::TargetLengthOverflow)?;
    let state = match desired {
        DesiredState::Connected => 0,
        DesiredState::Disconnected => 1,
    };
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update(size.to_be_bytes());
    digest.update(target.as_bytes());
    digest.update(expected_sequence.to_be_bytes());
    digest.update([state]);
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_shared_sqlite_receipt_digests() {
        let vectors = include_str!("../../../protocol/ssh-owner/v1.golden.transitions");
        for (name, target, seq, desired) in [
            (
                "initial_disconnect",
                "ssh:fixture",
                0,
                DesiredState::Disconnected,
            ),
            ("initial_connect", "ssh:fixture", 0, DesiredState::Connected),
            (
                "next_disconnect",
                "ssh:fixture",
                1,
                DesiredState::Disconnected,
            ),
            (
                "unicode_target",
                "ssh:fixture-λ",
                MAX_EXPECTED_SEQUENCE,
                DesiredState::Disconnected,
            ),
        ] {
            let key = format!("{name}.sha256=");
            let expected = vectors
                .lines()
                .find_map(|row| row.strip_prefix(&key))
                .unwrap();
            assert_eq!(transition_digest(target, seq, desired).unwrap(), expected);
        }
    }

    #[test]
    fn refuses_sequence_that_cannot_be_advanced_by_the_storage_adapter() {
        assert_eq!(
            transition_digest(
                "ssh:fixture",
                MAX_EXPECTED_SEQUENCE + 1,
                DesiredState::Connected
            ),
            Err(DigestError::SequenceOutOfRange),
        );
    }
}
