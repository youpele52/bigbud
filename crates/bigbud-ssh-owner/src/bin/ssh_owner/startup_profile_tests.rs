use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn state_directory() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "bigbud-owner-profile-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    fs::canonicalize(&root).unwrap()
}

fn hex(value: &str) -> [u8; 32] {
    let mut bytes = [0; 32];
    for (byte, pair) in bytes.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    bytes
}

#[test]
fn matches_the_cross_language_preimage_vector() {
    assert_eq!(
        digest(
            ProfileKind::DesktopPackaged,
            "/var/lib/bigbud",
            "16777220",
            "123456789"
        ),
        hex("4352f14d69f3d45c82c62495095c9cf90a216ccabf6845ffb23e0ed6cadbda78")
    );
}

#[test]
fn parses_only_the_exact_versioned_form() {
    let value = "bbso1:desktop-packaged:\
                 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let parsed = ProductionProfile::parse(value).expect("valid profile");
    assert_eq!(parsed.kind, ProfileKind::DesktopPackaged);
    assert_eq!(parsed.digest, [0xaa; 32]);
    for malformed in [
        "bbso1:desktop-packaged",
        "bbso2:desktop-packaged:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbso1:unknown:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbso1:desktop-packaged:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "bbso1:desktop-packaged:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x",
    ] {
        assert!(ProductionProfile::parse(malformed).is_err(), "{malformed}");
    }
    assert_eq!(
        ProductionProfile::parse(
            "bbso1:unknown:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .unwrap_err(),
        ProfileRefusal::UnknownKind
    );
}

#[test]
fn verifies_the_state_directory_and_refuses_a_mismatch() {
    let root = state_directory();
    let metadata = fs::symlink_metadata(&root).unwrap();
    let path = root.to_str().unwrap();
    let good = ProductionProfile {
        kind: ProfileKind::Standalone,
        digest: digest(
            ProfileKind::Standalone,
            path,
            &metadata.dev().to_string(),
            &metadata.ino().to_string(),
        ),
    };
    assert_eq!(good.verify(&root).unwrap(), root);
    let mut bad = good.clone();
    bad.digest[0] ^= 0xff;
    assert_eq!(
        bad.verify(&root).unwrap_err(),
        ProfileRefusal::ProfileMismatch
    );
    let mut other_kind = good;
    other_kind.kind = ProfileKind::RemoteBackend;
    assert_eq!(
        other_kind.verify(&root).unwrap_err(),
        ProfileRefusal::ProfileMismatch
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refuses_missing_non_canonical_and_unsafe_state_directories() {
    let root = state_directory();
    let missing = root.join("missing");
    let profile = ProductionProfile {
        kind: ProfileKind::DesktopDev,
        digest: [0; 32],
    };
    assert_eq!(
        profile.verify(&missing).unwrap_err(),
        ProfileRefusal::StateDirectoryMissing
    );
    let link = root.join("link");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    assert_eq!(
        profile.verify(&link).unwrap_err(),
        ProfileRefusal::StateDirectoryNotCanonical
    );
    fs::set_permissions(&root, std::os::unix::fs::PermissionsExt::from_mode(0o777)).unwrap();
    assert_eq!(
        profile.verify(&root).unwrap_err(),
        ProfileRefusal::StateDirectoryUnsafe
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refusal_records_are_bounded_and_redacted() {
    let mut out = Vec::new();
    report_refusal(ProfileRefusal::ProfileMismatch, &mut out);
    let record = String::from_utf8(out).unwrap();
    assert!(record.contains("\"event\":\"ssh_owner_production_refused\""));
    assert!(record.contains("\"code\":\"production_profile_mismatch\""));
    assert!(!record.contains('/'));
    assert!(record.len() <= 512);
}
