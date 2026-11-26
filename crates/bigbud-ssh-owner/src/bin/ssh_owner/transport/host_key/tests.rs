//! U23 host-key parsing against real `ssh-keygen` public keys (throwaway
//! keys generated for this test; fingerprints from `ssh-keygen -l`).

use super::fixtures::*;
use super::*;

const LABEL: &str = "[10.0.0.5]:2222";

fn parse(record: &str) -> Option<HostKey> {
    HostKey::from_record(format!("{LABEL} {record}\n").as_bytes(), LABEL)
}

#[test]
fn every_accepted_type_parses_with_the_openssh_fingerprint() {
    for ((record, fingerprint), kind) in [
        (ECDSAB256, KeyType::EcdsaP256),
        (ECDSAB384, KeyType::EcdsaP384),
        (ECDSAB521, KeyType::EcdsaP521),
        (RSAB2048, KeyType::Rsa),
        (RSAB1024, KeyType::Rsa),
    ] {
        let key = parse(record).unwrap_or_else(|| panic!("{record}"));
        assert_eq!(key.kind(), kind);
        assert_eq!(key.fingerprint(), fingerprint);
        assert_eq!(key.record_value(), record);
        assert_eq!(key.record(LABEL), format!("{LABEL} {record}\n"));
    }
    assert_eq!(KeyType::Rsa.algorithms(), "rsa-sha2-512,rsa-sha2-256");
}

#[test]
fn malformed_mislabelled_or_refused_types_fail() {
    let (ecdsa, _) = ECDSAB256;
    let (rsa, _) = RSAB2048;
    // The blob names a different type than the record.
    assert!(parse(&ecdsa.replace("ecdsa-sha2-nistp256 ", "ecdsa-sha2-nistp384 ")).is_none());
    assert!(parse(&rsa.replace("ssh-rsa ", "ssh-ed25519 ")).is_none());
    // DSA and unknown types are refused.
    assert!(parse("ssh-dss AAAAB3NzaC1kc3MAAACBAP").is_none());
    assert!(parse("rsa-sha2-512 AAAA").is_none());
    // Truncated, padded wrongly or with trailing bytes.
    let truncated = rsa.get(..rsa.len() - 8).expect("ASCII record");
    assert!(parse(truncated).is_none());
    assert!(parse(&format!("{rsa}AAAA")).is_none());
    assert!(parse(&format!("{ecdsa}=")).is_none());
}

#[test]
fn a_multi_type_keyscan_is_ordered_ed25519_first_and_unique_per_type() {
    let (rsa, _) = RSAB2048;
    let (ecdsa, _) = ECDSAB256;
    let ed25519 =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let scan = format!("# banner\n{LABEL} {rsa}\n{LABEL} {ecdsa}\n{LABEL} {ed25519}\n");
    let keys = HostKey::from_keyscan_all(scan.as_bytes(), LABEL).expect("three keys");
    let kinds: Vec<_> = keys.iter().map(HostKey::kind).collect();
    assert_eq!(kinds, [KeyType::Ed25519, KeyType::EcdsaP256, KeyType::Rsa]);
    assert!(HostKey::from_keyscan(scan.as_bytes(), LABEL).is_none());
    let twice = format!("{LABEL} {rsa}\n{LABEL} {rsa}\n");
    assert!(HostKey::from_keyscan_all(twice.as_bytes(), LABEL).is_none());
    assert!(HostKey::from_keyscan_all(b"# only a banner\n", LABEL).is_none());
}
