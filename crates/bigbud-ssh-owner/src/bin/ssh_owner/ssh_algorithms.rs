//! U22 user-authentication algorithms, shared by every platform's launch.
//! Modern OpenSSH's defaults in its order, minus SHA-1 `ssh-rsa`, DSA and
//! certificate forms. String macros, because the launch option lists are
//! `const` string slices.

/// ed25519 and ECDSA: understood by every supported OpenSSH, including the
/// Windows inbox client (8.1 and later).
macro_rules! user_auth_core {
    () => {
        "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521"
    };
}

/// Security-key forms (OpenSSH 8.2 and later; not the Windows 8.1 inbox).
#[cfg(unix)]
macro_rules! user_auth_security_keys {
    () => {
        "sk-ssh-ed25519@openssh.com,sk-ecdsa-sha2-nistp256@openssh.com"
    };
}

/// RSA keys, only with SHA-2 signatures.
macro_rules! user_auth_rsa {
    () => {
        "rsa-sha2-512,rsa-sha2-256"
    };
}
