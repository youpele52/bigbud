use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::{PasteError, PasteLimits, PasteStore};

const SCOPE: &str = "0123456789abcdef0123456789abcdef";
const OTHER_SCOPE: &str = "fedcba9876543210fedcba9876543210";

fn temp_root(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("bigbud-paste-{label}-{suffix}/agent/paste"))
}

fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn stage(store: &mut PasteStore, scope: &str, id: &str, bytes: &[u8]) -> PathBuf {
    store
        .begin(scope, id, bytes.len() as u64, "png", "image/png")
        .unwrap();
    for (index, chunk) in bytes.chunks(4).enumerate() {
        store.chunk(id, (index * 4) as u64, chunk).unwrap();
    }
    store.commit(id, &digest(bytes)).unwrap().path
}

#[test]
fn assembles_chunks_into_a_private_absolute_file() {
    let root = temp_root("assemble");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    let path = stage(
        &mut store,
        SCOPE,
        "0123456789abcdef",
        b"hello paste staging",
    );
    assert!(path.is_absolute(), "{path:?}");
    assert_eq!(path, fs::canonicalize(&path).unwrap());
    assert!(path.starts_with(store.root().join(SCOPE)));
    let name = path.file_name().unwrap().to_str().unwrap();
    assert!(
        name.starts_with("paste-") && name.ends_with(".png"),
        "{name}"
    );
    assert!(!name.contains(' '));
    assert_eq!(fs::read(&path).unwrap(), b"hello paste staging");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(store.root()), 0o700);
        assert_eq!(mode(&store.root().join(SCOPE)), 0o700);
    }
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn rejects_digest_mismatch_and_removes_the_partial_file() {
    let root = temp_root("digest");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    store
        .begin(SCOPE, "0123456789abcdef", 3, "bin", "")
        .unwrap();
    store.chunk("0123456789abcdef", 0, b"abc").unwrap();
    let error = store
        .commit("0123456789abcdef", &digest(b"abd"))
        .unwrap_err();
    assert!(matches!(error, PasteError::DigestMismatch));
    assert_eq!(fs::read_dir(store.root().join(SCOPE)).unwrap().count(), 0);
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn rejects_out_of_order_oversized_and_incomplete_uploads() {
    let root = temp_root("order");
    let limits = PasteLimits {
        max_chunk_bytes: 4,
        max_file_bytes: 8,
        ..PasteLimits::default()
    };
    let mut store = PasteStore::open(&root, limits).unwrap();
    assert!(matches!(
        store.begin(SCOPE, "0123456789abcdef", 9, "bin", ""),
        Err(PasteError::TooLarge)
    ));
    store
        .begin(SCOPE, "0123456789abcdef", 8, "bin", "")
        .unwrap();
    assert!(matches!(
        store.chunk("0123456789abcdef", 4, b"abcd"),
        Err(PasteError::OutOfOrder)
    ));
    // A failed chunk ends the upload; nothing can be appended afterwards.
    assert!(matches!(
        store.chunk("0123456789abcdef", 0, b"abcd"),
        Err(PasteError::UnknownUpload)
    ));
    store
        .begin(SCOPE, "1123456789abcdef", 8, "bin", "")
        .unwrap();
    assert!(matches!(
        store.chunk("1123456789abcdef", 0, b"abcde"),
        Err(PasteError::OutOfOrder)
    ));
    store
        .begin(SCOPE, "2123456789abcdef", 8, "bin", "")
        .unwrap();
    store.chunk("2123456789abcdef", 0, b"abcd").unwrap();
    assert!(matches!(
        store.commit("2123456789abcdef", &digest(b"abcd")),
        Err(PasteError::Incomplete)
    ));
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn rejects_unsafe_names_before_touching_the_filesystem() {
    let root = temp_root("names");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    for (scope, id, extension, mime) in [
        (
            "../../../../tmp/evil00000000000000",
            "0123456789abcdef",
            "png",
            "",
        ),
        (SCOPE, "../0123456789abcdef", "png", ""),
        (SCOPE, "0123456789abcdef", "p/ng", ""),
        (SCOPE, "0123456789abcdef", "png ", ""),
        (SCOPE, "0123456789abcdef", "png", "text/html"),
    ] {
        assert!(matches!(
            store.begin(scope, id, 1, extension, mime),
            Err(PasteError::InvalidArgument(_))
        ));
    }
    assert_eq!(fs::read_dir(store.root()).unwrap().count(), 0);
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn discards_a_scope_and_keeps_other_terminals_files() {
    let root = temp_root("discard");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    let mine = stage(&mut store, SCOPE, "0123456789abcdef", b"mine");
    let other = stage(&mut store, OTHER_SCOPE, "1123456789abcdef", b"other");
    store
        .begin(SCOPE, "2123456789abcdef", 10, "bin", "")
        .unwrap();
    assert_eq!(store.discard(SCOPE, "").unwrap(), 2);
    assert!(!mine.exists());
    assert!(!store.root().join(SCOPE).exists());
    assert!(other.exists());
    assert!(matches!(
        store.chunk("2123456789abcdef", 0, b"a"),
        Err(PasteError::UnknownUpload)
    ));
    assert_eq!(
        store.discard(SCOPE, "").unwrap(),
        0,
        "discard is idempotent"
    );
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn enforces_the_total_cap_and_upload_count() {
    let root = temp_root("cap");
    let limits = PasteLimits {
        max_total_bytes: 10,
        max_uploads: 1,
        ..PasteLimits::default()
    };
    let mut store = PasteStore::open(&root, limits).unwrap();
    let oldest = stage(&mut store, SCOPE, "0123456789abcdef", b"123456");
    std::thread::sleep(Duration::from_millis(20));
    let newer = stage(&mut store, SCOPE, "1123456789abcdef", b"1234");
    assert!(oldest.exists() && newer.exists());
    let newest = stage(&mut store, SCOPE, "2123456789abcdef", b"12345");
    assert!(!oldest.exists(), "the oldest file is evicted first");
    assert!(newer.exists() && newest.exists());
    assert!(matches!(
        store.begin(SCOPE, "3123456789abcdef", 11, "bin", ""),
        Err(PasteError::ResourceLimit(_))
    ));
    store
        .begin(SCOPE, "4123456789abcdef", 1, "bin", "")
        .unwrap();
    assert!(matches!(
        store.begin(SCOPE, "5123456789abcdef", 1, "bin", ""),
        Err(PasteError::ResourceLimit(_))
    ));
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[test]
fn sweeps_files_older_than_the_ttl() {
    let root = temp_root("sweep");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    let path = stage(&mut store, SCOPE, "0123456789abcdef", b"old");
    assert_eq!(store.sweep(SystemTime::now()).unwrap(), 0);
    let later = SystemTime::now() + Duration::from_secs(25 * 60 * 60);
    assert_eq!(store.sweep(later).unwrap(), 1);
    assert!(!path.exists());
    assert!(!store.root().join(SCOPE).exists());
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_scope_folder() {
    let root = temp_root("symlink");
    let mut store = PasteStore::open(&root, PasteLimits::default()).unwrap();
    let outside = root.parent().unwrap().join("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, store.root().join(SCOPE)).unwrap();
    assert!(matches!(
        store.begin(SCOPE, "0123456789abcdef", 1, "bin", ""),
        Err(PasteError::Insecure(_))
    ));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
}
