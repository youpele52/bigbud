use super::*;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::time::Duration;

const LABEL: &str = "[127.0.0.1]:2200";
const KEY: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
// Independent HMAC-SHA1 vectors using the salt bytes 0 through 19.
const HASH: &str = "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|F64Oz4eVvZPbzvr8P8NDLnjX8go=";
const ALIAS_HASH: &str = "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|yvQvl62xAArgQEC2C7SGiQcQGsE=";

struct PrivateDirectory(PathBuf);

impl PrivateDirectory {
    fn new() -> Self {
        let nonce = NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "bigbud-picker-pin-test-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("fixture directory");
        Self(path)
    }

    fn pin_file(&self) -> PathBuf {
        let path = self.0.join("known_hosts");
        options()
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("fixture trust file");
        path
    }
}

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn cancellable_picker_direct_trust_refuses_hashed_pins() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    fs::write(&path, KEY).expect("write plain fixture pin");
    assert!(matches!(read_plain(&path, LABEL), Ok(Some(_))));
    fs::write(&path, KEY.replacen(LABEL, HASH, 1)).expect("write hashed fixture pin");
    assert!(matches!(
        read_plain(&path, LABEL),
        Err(ErrorCode::ConfigUnsupported)
    ));
}

#[test]
fn pins_once_and_keeps_a_separate_snapshot() {
    let directory = PrivateDirectory::new();
    let path = directory.0.join("known_hosts");
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    let changed = KEY.replace("AAAA\n", "AAAB\n");
    let other = HostKey::from_record(changed.as_bytes(), LABEL).expect("changed fixture key");
    let deadline = Instant::now() + Duration::from_secs(2);
    assert!(matches!(read(&path, LABEL), Ok(None)));
    assert_eq!(directory.pin_file(), path);
    assert_eq!(approve(&path, LABEL, &key, false, deadline), Ok(()));
    assert_eq!(approve(&path, LABEL, &key, true, deadline), Ok(()));
    assert_eq!(
        approve(&path, LABEL, &other, true, deadline),
        Err(ErrorCode::HostKeyChanged)
    );
    assert_eq!(fs::read_to_string(&path).expect("fixture pin"), KEY);
    let pin = read(&path, LABEL).expect("read pin").expect("verified pin");
    let snapshot = Snapshot::new(&path, &pin).expect("snapshot creation");
    fs::write(&path, changed).expect("change fixture pin");
    assert_eq!(
        fs::read_to_string(snapshot.path()).expect("snapshot pin"),
        KEY
    );
    let snapshot_path = snapshot.path().to_owned();
    drop(snapshot);
    assert!(!snapshot_path.exists());

    let alias = directory.0.join("symlink");
    symlink(&path, &alias).expect("fixture symlink");
    assert!(matches!(
        read(&alias, LABEL),
        Err(ErrorCode::TrustStoreReadOnly)
    ));
    assert_eq!(
        approve(&alias, LABEL, &key, true, deadline),
        Err(ErrorCode::TrustStoreReadOnly)
    );
}

#[test]
fn approval_creates_only_one_hashed_pin_and_never_rehashes_it() {
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    for (label, other) in [(LABEL, "[127.0.0.1]:2201"), ("fixture-key", LABEL)] {
        let directory = PrivateDirectory::new();
        let path = directory.pin_file();
        let deadline = Instant::now() + Duration::from_secs(3);
        assert_eq!(approve(&path, label, &key, true, deadline), Ok(()));
        let record = fs::read_to_string(&path).expect("generated pin");
        assert!(record.starts_with("|1|"));
        assert!(!record.contains(label));
        assert_eq!(record.lines().count(), 1);
        assert_eq!(fs::metadata(&path).expect("pin mode").mode() & 0o777, 0o600);
        assert!(matches!(read(&path, label), Ok(Some(pin)) if pin.key == key));
        assert!(matches!(read(&path, other), Err(ErrorCode::HostKeyChanged)));
        assert_eq!(approve(&path, label, &key, true, deadline), Ok(()));
        assert_eq!(approve(&path, label, &key, false, deadline), Ok(()));
        assert_eq!(fs::read_to_string(&path).expect("unchanged pin"), record);
        let entries = fs::read_dir(&directory.0)
            .expect("fixture directory")
            .map(|entry| entry.expect("fixture entry").path())
            .collect::<Vec<_>>();
        assert_eq!(entries, [path]); // No cleartext input, .old or staging directory remains.
    }
}

#[test]
fn invalid_generated_hash_output_leaves_no_pin_or_staging_files() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    // The resolver never admits this label. OpenSSH rehashes it as a list
    // rather than the one exact record we accept from the helper.
    assert_eq!(
        approve(
            &path,
            "fixture-key,other",
            &key,
            true,
            Instant::now() + Duration::from_secs(3)
        ),
        Err(READ_ONLY)
    );
    assert!(fs::read(&path).expect("empty pin file").is_empty());
    assert_eq!(
        fs::read_dir(&directory.0)
            .expect("fixture directory")
            .count(),
        1
    );
}

#[test]
fn hashed_pin_matches_only_the_exact_port_label_or_alias() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    let changed = KEY.replace("AAAA\n", "AAAB\n");
    let changed = HostKey::from_record(changed.as_bytes(), LABEL).expect("changed fixture key");
    for (field, label, other_label) in [
        (HASH, LABEL, "[127.0.0.1]:2201"),
        (ALIAS_HASH, "fixture-key", "other-key"),
    ] {
        let record = key.record(field);
        fs::write(&path, &record).expect("write hashed pin");
        assert!(matches!(read(&path, label), Ok(Some(pin)) if pin.key == key));
        assert!(matches!(
            read(&path, other_label),
            Err(ErrorCode::HostKeyChanged)
        ));
        let deadline = Instant::now() + Duration::from_secs(3);
        assert_eq!(approve(&path, label, &key, true, deadline), Ok(()));
        assert_eq!(
            approve(&path, label, &changed, true, deadline),
            Err(ErrorCode::HostKeyChanged)
        );
        assert_eq!(
            approve(&path, other_label, &key, true, deadline),
            Err(ErrorCode::HostKeyChanged)
        );
        assert_eq!(fs::read_to_string(&path).expect("original pin"), record);
    }
}

#[test]
fn hashed_pin_snapshots_are_private_and_not_reused_after_source_eviction() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    fs::write(&path, key.record(HASH).trim_end()).expect("write pin without newline");
    let pin = read(&path, LABEL)
        .expect("read hashed pin")
        .expect("verified pin");
    let snapshot = Snapshot::new(&path, &pin).expect("snapshot creation");
    let snapshot_path = snapshot.path().to_owned();
    assert_eq!(
        fs::metadata(&snapshot_path).expect("snapshot mode").mode() & 0o777,
        0o600
    );
    fs::remove_file(&path).expect("evict source pin");
    assert!(matches!(read(&path, LABEL), Ok(None)));
    assert_eq!(directory.pin_file(), path);
    fs::write(&path, format!("@revoked {}", key.record(HASH))).expect("revoke source pin");
    assert!(matches!(read(&path, LABEL), Err(ErrorCode::HostKeyChanged)));
    assert_eq!(
        fs::read_to_string(&snapshot_path).expect("in-flight snapshot"),
        key.record(HASH)
    );
    drop(snapshot);
    assert!(!snapshot_path.exists());
}

#[test]
fn comments_and_blank_lines_do_not_change_the_exact_pin() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    for record in [KEY.to_owned(), key.record(HASH)] {
        let text = format!("# managed by the fixture\r\n\t \r\n{record}   # after the pin");
        fs::write(&path, &text).expect("write commented pin");
        let pin = read(&path, LABEL)
            .expect("read commented store")
            .expect("find its exact pin");
        assert!(pin.key == key);
        let snapshot = Snapshot::new(&path, &pin).expect("create snapshot");
        assert_eq!(
            fs::read_to_string(snapshot.path()).expect("snapshot"),
            record
        );
        assert!(matches!(
            read(&path, "[127.0.0.1]:2201"),
            Err(ErrorCode::HostKeyChanged)
        ));
        assert_eq!(
            approve(
                &path,
                LABEL,
                &key,
                false,
                Instant::now() + Duration::from_secs(3)
            ),
            Ok(())
        );
        assert_eq!(fs::read_to_string(&path).expect("original file"), text);
    }
}

#[test]
fn approval_preserves_comments_and_terminates_the_last_line() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    let max_unterminated = format!("#{}", "x".repeat(MAX_PIN_BYTES as usize - 2));
    for (comments, hash) in [
        ("# note without newline", false),
        ("# note\n\t \n", true),
        (max_unterminated.as_str(), true),
    ] {
        fs::write(&path, comments).expect("write comment-only store");
        assert!(matches!(read(&path, LABEL), Ok(None)));
        let deadline = Instant::now() + Duration::from_secs(3);
        assert_eq!(approve(&path, LABEL, &key, hash, deadline), Ok(()));
        let stored = fs::read_to_string(&path).expect("read appended pin");
        let prefix = if comments.ends_with('\n') {
            comments.to_owned()
        } else {
            format!("{comments}\n")
        };
        let record = stored.strip_prefix(&prefix).expect("preserve comments");
        if hash {
            assert!(record.starts_with("|1|"));
            assert!(!record.contains(LABEL));
        } else {
            assert_eq!(record, KEY);
        }
        assert!(matches!(read(&path, LABEL), Ok(Some(pin)) if pin.key == key));
        assert_eq!(approve(&path, LABEL, &key, hash, deadline), Ok(()));
        assert_eq!(fs::read_to_string(&path).expect("unchanged store"), stored);
    }
}

#[test]
fn approval_will_not_grow_a_valid_comment_only_store_past_the_limit() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    let comments = "# note!\n".repeat(MAX_STORE_BYTES as usize / 8);
    fs::write(&path, &comments).expect("write full comment-only store");
    assert!(matches!(read(&path, LABEL), Ok(None)));
    assert_eq!(
        approve(
            &path,
            LABEL,
            &key,
            false,
            Instant::now() + Duration::from_secs(3)
        ),
        Err(READ_ONLY)
    );
    assert_eq!(
        fs::read_to_string(&path).expect("unchanged store"),
        comments
    );
}

#[test]
fn hashed_pin_never_masks_other_records_or_malformed_data() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    let record = key.record(HASH);
    let changed = KEY.replace("AAAA\n", "AAAB\n");
    for invalid in [
        format!("{record}{changed}"),
        format!("{changed}{record}"),
        format!("{record}\n# do not mask a revocation\n@revoked {KEY}"),
        format!("# comments cannot enable markers\n@revoked {record}"),
        format!("# comments cannot enable CA trust\n@cert-authority {record}"),
        format!("{record}\n# do not mask duplicates\n{record}"),
        // Over the per-record cap (4 KiB since U23) and the store cap (64 KiB).
        format!("{record}{}", " ".repeat(4096)),
        format!("{record}# invalid control byte\0\n"),
        format!("{record}{}", "# note\n".repeat(10_000)),
        record.replace("|1|", "|2|"),
        record.replace("AAECA", "AAEC!"),
        record.replace("0ODxAREhM=", "0ODxAREhN="),
        record.replace("njX8go=", "njX8gk="),
    ] {
        fs::write(&path, &invalid).expect("write denied fixture");
        assert!(matches!(read(&path, LABEL), Err(ErrorCode::HostKeyChanged)));
        assert_eq!(
            approve(
                &path,
                LABEL,
                &key,
                true,
                Instant::now() + Duration::from_secs(3)
            ),
            Err(ErrorCode::HostKeyChanged)
        );
        assert_eq!(
            fs::read_to_string(&path).expect("unchanged denied file"),
            invalid
        );
    }
}

#[test]
fn hashed_pin_does_not_relax_private_file_checks() {
    let directory = PrivateDirectory::new();
    let path = directory.pin_file();
    let key = HostKey::from_record(KEY.as_bytes(), LABEL).expect("fixture key");
    fs::write(&path, key.record(HASH)).expect("write hashed pin");
    let assert_read_only = || {
        assert!(matches!(read(&path, LABEL), Err(READ_ONLY)));
        assert_eq!(
            approve(
                &path,
                LABEL,
                &key,
                true,
                Instant::now() + Duration::from_secs(3)
            ),
            Err(READ_ONLY)
        );
    };
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("public file");
    assert_read_only();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private file");
    let link = directory.0.join("hardlink");
    fs::hard_link(&path, &link).expect("hardlink");
    assert_read_only();
    fs::remove_file(link).expect("remove hardlink");
    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).expect("public directory");
    assert_read_only();
}
