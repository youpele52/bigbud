use super::{CredentialMode, MuxPath, decode_base64, identity_is_encrypted};
use std::{fs, path::PathBuf};

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |acc, (index, byte)| {
            acc | u32::from(*byte) << (16 - 8 * index)
        });
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(TABLE[(value >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn key_file(name: &str, cipher: &str) -> PathBuf {
    let mut body = b"openssh-key-v1\0".to_vec();
    body.extend((cipher.len() as u32).to_be_bytes());
    body.extend(cipher.as_bytes());
    body.extend([0, 0, 0, 4]);
    body.extend(b"none");
    let path = std::env::temp_dir().join(format!("bb-cred-{}-{name}", std::process::id()));
    fs::write(
        &path,
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n",
            encode_base64(&body)
        ),
    )
    .expect("write key fixture");
    path
}

#[test]
fn an_openssh_key_with_a_cipher_needs_a_passphrase() {
    let encrypted = key_file("enc", "aes256-ctr");
    let plain = key_file("plain", "none");
    assert!(identity_is_encrypted(&encrypted));
    assert!(!identity_is_encrypted(&plain));
    let _ = fs::remove_file(encrypted);
    let _ = fs::remove_file(plain);
}

#[test]
fn legacy_encrypted_pem_and_unreadable_files() {
    let pem = std::env::temp_dir().join(format!("bb-cred-{}-pem", std::process::id()));
    fs::write(
        &pem,
        "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n-----END RSA PRIVATE KEY-----\n",
    )
    .expect("write pem");
    assert!(identity_is_encrypted(&pem));
    let _ = fs::remove_file(pem);
    assert!(!identity_is_encrypted(std::path::Path::new(
        "/nonexistent/bigbud/identity"
    )));
}

#[test]
fn base64_round_trip_and_rejects_foreign_bytes() {
    assert_eq!(
        decode_base64(&encode_base64(b"bigbud")).as_deref(),
        Some(&b"bigbud"[..])
    );
    assert!(decode_base64("ab$c").is_none());
}

#[test]
fn the_mux_path_publishes_and_clears() {
    let mux = MuxPath::default();
    assert!(mux.get().is_none());
    mux.publish(PathBuf::from("/tmp/bbcm-x/s"));
    assert_eq!(mux.clone().get(), Some(PathBuf::from("/tmp/bbcm-x/s")));
    mux.clear();
    assert!(mux.get().is_none());
    assert_eq!(CredentialMode::default(), CredentialMode::None);
}
