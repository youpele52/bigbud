//! SHA-256 through the workspace `sha2` crate (locked 0.10.9, already used by
//! bigbud-desktop-supervisor and bigbud-remote-agent). One portable code path
//! serves every target: the retained image digest and the canonical policy
//! digest, pinned by the NIST known answers below on every host.
use sha2::{Digest, Sha256};

/// One-shot digest of an in-memory buffer (e.g. canonical policy bytes).
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    fn hex(bytes: [u8; 32]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn sha(data: &[u8]) -> String {
        hex(sha256(data))
    }
    #[test]
    fn nist_known_answers_including_multi_chunk_input() {
        assert_eq!(
            sha(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            sha(&vec![b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
