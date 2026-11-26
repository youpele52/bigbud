//! V1 attachment transcripts, shared by the Unix picker proof and Windows pipe tests.

use std::hint::black_box;

use sha2::{Digest, Sha256};

pub(super) type Token = [u8; 32];

#[derive(Clone, Copy)]
pub(super) enum Role {
    Server,
    Client,
}

pub(super) fn transcript_proof(
    key: &Token,
    role: Role,
    profile: &[u8],
    client_nonce: &Token,
    server_nonce: &Token,
) -> Token {
    let label: &[u8] = match role {
        Role::Server => b"bigbud.ssh-owner.proof-server.v1\0",
        Role::Client => b"bigbud.ssh-owner.proof-client.v1\0",
    };
    // RFC 2104: the fixed 32-byte key is zero-padded to SHA-256's 64-byte block.
    let mut inner_pad = [0x36; 64];
    let mut outer_pad = [0x5c; 64];
    for ((inner, outer), key_byte) in inner_pad.iter_mut().zip(&mut outer_pad).zip(key) {
        *inner ^= key_byte;
        *outer ^= key_byte;
    }
    let inner = Sha256::new()
        .chain_update(inner_pad)
        .chain_update(label)
        .chain_update(profile)
        .chain_update(client_nonce)
        .chain_update(server_nonce)
        .finalize();
    Sha256::new()
        .chain_update(outer_pad)
        .chain_update(inner)
        .finalize()
        .into()
}

pub(super) fn proof_matches(expected: &Token, presented: &Token) -> bool {
    let mut difference = 0;
    for (expected_byte, presented_byte) in expected.iter().zip(presented) {
        // Keep the fixed-size reduction from being rewritten into a short-circuit comparison.
        difference = black_box(difference | (expected_byte ^ presented_byte));
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_matches_independent_hmac_sha256_transcript_vectors() {
        let key = std::array::from_fn(|i| i as u8);
        let client_nonce = std::array::from_fn(|i| (i + 32) as u8);
        let server_nonce = std::array::from_fn(|i| (i + 64) as u8);
        for (role, expected_hex) in [
            (
                Role::Server,
                "0ccd3aa87d437c4c874767ca418fce1de0fd71da0a5ae5c4211db699061e584d",
            ),
            (
                Role::Client,
                "4d37008410d3ce6598d07a89f42a18172795ab30d2ab8ae7d46cd86a2e2563f4",
            ),
        ] {
            assert_vector(
                transcript_proof(&key, role, b"fixture-profile", &client_nonce, &server_nonce),
                expected_hex,
            );
        }
        for (role, expected_hex) in [
            (
                Role::Server,
                "0562da453074e33a2e7188b37b07bd6273a18e80b8fa1f663fe6f27a16ae6da2",
            ),
            (
                Role::Client,
                "2a209eb9eca4655bbf2b0e096d837b03bc425dcfd85f9ee98939275b905a0536",
            ),
        ] {
            assert_vector(
                transcript_proof(&key, role, &[0, 0x81, 0xff], &[1; 32], &[2; 32]),
                expected_hex,
            );
        }
    }

    fn assert_vector(computed: Token, expected_hex: &str) {
        let expected = std::array::from_fn(|i| {
            let byte = expected_hex
                .get(2 * i..2 * i + 2)
                .expect("fixed ASCII vector");
            u8::from_str_radix(byte, 16).expect("hex vector")
        });
        assert!(proof_matches(&computed, &expected));
        for i in 0..32 {
            let mut wrong = expected;
            wrong[i] ^= 1;
            assert!(!proof_matches(&computed, &wrong));
        }
    }
}
