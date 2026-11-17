#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
const GOLDEN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/shared/src/mobileOptionalAssets/fixtures/native-receipt-v1.json"
));
#[test]
fn native_interprets_exact_shared_canonical_receipt_and_raw_utf8_path_digests() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let raw = golden["canonicalUtf8"].as_str().unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(raw.as_bytes())),
        golden["sha256"].as_str().unwrap()
    );
    let receipt = Receipt::parse(raw.as_bytes()).unwrap();
    assert_eq!(receipt.entries.len(), 2);
    for row in golden["vectors"].as_array().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::new()
                    .chain_update(b"bigbud.mobile-native-assets-entry.v1\0")
                    .chain_update(row["kind"].as_str().unwrap())
                    .chain_update(b"\0")
                    .chain_update(row["relative"].as_str().unwrap())
                    .finalize()
            ),
            row["digest"].as_str().unwrap()
        );
        let actual = model::path_digest(
            row["kind"] == "directory",
            row["relative"].as_str().unwrap(),
        );
        assert_eq!(
            actual
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            row["digest"].as_str().unwrap()
        );
    }
}
fn anchor_value(m: &std::fs::Metadata) -> Value {
    json!({"dev":m.dev().to_string(),"ino":m.ino().to_string(),"uid":m.uid().to_string(),"gid":m.gid().to_string(),"mode":m.mode().to_string()})
}
fn stat_value(m: &std::fs::Metadata) -> Value {
    let mut v = anchor_value(m);
    let s = tree::stamp(m).unwrap();
    for (key, n) in [
        ("nlink", s.nlink),
        ("size", s.size),
        ("mtimeNs", s.mtime),
        ("ctimeNs", s.ctime),
    ] {
        v[key] = n.to_string().into();
    }
    v
}
struct Fixture {
    state: PathBuf,
    root: PathBuf,
    reference: Resource,
    binding: Binding,
    args: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "native-assets-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = std::fs::canonicalize(path).unwrap();
        let generation = format!("assets-{}", "0".repeat(32));
        let namespace = state.join("remote-mobile-runtime-v1");
        let root = namespace.join(&generation);
        for path in [&namespace, &root] {
            std::fs::create_dir(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let file = root.join("index.html");
        std::fs::write(&file, b"hello").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut value: Value = serde_json::from_str(GOLDEN).unwrap();
        let value = &mut value["receipt"];
        for (key, path) in [
            ("state", &state),
            ("namespace", &namespace),
            ("root", &root),
        ] {
            value["anchors"][key] = anchor_value(&std::fs::symlink_metadata(path).unwrap());
        }
        let rows = value["entries"].as_array_mut().unwrap();
        for row in rows {
            let path = if row["kind"] == "directory" {
                &root
            } else {
                &file
            };
            row["stat"] = stat_value(&std::fs::symlink_metadata(path).unwrap());
        }
        let bytes = serde_json::to_vec(value).unwrap();
        let sha256 = Sha256::digest(&bytes).into();
        let size = bytes.len() as u64;
        let receipt = namespace.join(format!("{generation}.receipt.json"));
        std::fs::write(receipt.clone(), bytes).unwrap();
        std::fs::set_permissions(receipt, std::fs::Permissions::from_mode(0o600)).unwrap();
        let reference = Resource::new(
            state.clone(),
            generation,
            size,
            sha256,
            "--assets-dir".into(),
        )
        .unwrap();
        let binding = Binding {
            authority: "a".repeat(32),
            installation: format!("sha256:{}", "c".repeat(64)),
            native_epoch: "epoch".into(),
            nonce: "fixture-attempt".into(),
            publication_sha256: [1; 32],
            executable_sha256: [2; 32],
            assets_sha256: [0xee; 32],
            configuration_sha256: [4; 32],
            guard_sha256: [5; 32],
        };
        let args = vec!["--assets-dir".into(), root.to_str().unwrap().into()];
        Self {
            state,
            root,
            reference,
            binding,
            args,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.state).unwrap();
    }
}
#[test]
fn verified_tree_is_bound_to_original_receipt_owner_and_actual_launch_option() {
    let f = Fixture::new();
    f.reference.validate(&f.binding, &f.args).unwrap();
    let mut args = f.args.clone();
    args[1] = "/another-tree".into();
    assert!(f.reference.validate(&f.binding, &args).is_err());
    args = f.args.clone();
    args.extend(f.args.clone());
    assert!(f.reference.validate_argument(&args).is_err());
    assert!(f
        .reference
        .validate_argument(&[format!("--assets-dir={}", f.root.display())])
        .is_err());
    let mut binding = f.binding.clone();
    binding.nonce = "another-original".into();
    assert!(f.reference.validate(&binding, &f.args).is_err());
}
#[test]
fn detached_tree_watch_detects_modification_extra_members_and_original_root_replacement() {
    let f = Fixture::new();
    let watch = f.reference.watch().unwrap();
    watch.check().unwrap();
    let file_path = f.root.join("index.html");
    std::fs::write(&file_path, b"other").unwrap();
    // Some Linux filesystems expose coarse timestamps. Make the metadata
    // mutation deterministic while keeping the replacement content the same size.
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
    std::fs::File::open(&file_path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(watch.check().is_err());
    let f = Fixture::new();
    let watch = f.reference.watch().unwrap();
    std::fs::write(f.root.join("extra.js"), b"new").unwrap();
    assert!(watch.check().is_err());
    let f = Fixture::new();
    let watch = f.reference.watch().unwrap();
    std::fs::rename(&f.root, f.root.with_extension("original")).unwrap();
    std::fs::create_dir(&f.root).unwrap();
    assert!(watch.check().is_err());
}
#[test]
fn receipt_substitution_or_symlink_cannot_reuse_original_custody() {
    let f = Fixture::new();
    let watch = f.reference.watch().unwrap();
    let path = f
        .state
        .join("remote-mobile-runtime-v1")
        .join(format!("{}.receipt.json", f.reference.generation));
    std::fs::rename(&path, path.with_extension("old")).unwrap();
    std::fs::write(&path, b"{}").unwrap();
    assert!(watch.check().is_err());
    assert!(f.reference.watch().is_err());
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(path.with_extension("old"), &path).unwrap();
    assert!(f.reference.watch().is_err());
}

#[test]
fn fifo_receipt_refuses_before_any_potentially_blocking_read() {
    let f = Fixture::new();
    let path = f
        .state
        .join("remote-mobile-runtime-v1")
        .join(format!("{}.receipt.json", f.reference.generation));
    std::fs::remove_file(&path).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let raw = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: NUL-terminated test-owned filename, exact POSIX mode, no pointer retention.
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();
    assert!(f.reference.watch().is_err());
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires explicit same-build BIGBUD_SERVICE_LEASE_TEST_BINARY; root runs contained Linux proof"]
fn native_original_child_exits_after_assets_modify_while_controller_is_detached() {
    use crate::service_lease::{Controller, Guard, Launch, LeaseOwner, SecretEnvironment, State};
    let f = Fixture::new();
    let monitor = PathBuf::from(std::env::var_os("BIGBUD_SERVICE_LEASE_TEST_BINARY").unwrap());
    let registry = f.state.join("registry.json");
    std::fs::write(&registry, b"{\"enabled\":true}").unwrap();
    std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o600)).unwrap();
    let stat = std::fs::metadata(&f.state).unwrap();
    let guard=Guard::parse(&serde_json::to_vec(&json!({"version":1,"file":registry,"anchors":[{"path":f.state,"dev":stat.dev().to_string(),"ino":stat.ino().to_string(),"uid":stat.uid().to_string(),"mode":448}],"all":[{"path":["enabled"],"values":[true]}],"select":[]})).unwrap()).unwrap();
    let executable = f.state.join("shell");
    std::fs::copy("/bin/sh", &executable).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut binding = f.binding.clone();
    binding.executable_sha256 = Sha256::digest(std::fs::read(&executable).unwrap()).into();
    binding.guard_sha256 = guard.digest();
    let mut args = vec![
        "-c".into(),
        "while IFS= read -r line; do :; done".into(),
        "native-fixture".into(),
    ];
    args.extend(f.args.clone());
    let mut owner = LeaseOwner::with_monitor(monitor, "epoch".into()).unwrap();
    let grant = owner
        .start(
            binding.clone(),
            Controller::current().unwrap(),
            &[7; 32],
            Launch {
                executable,
                args,
                environment: SecretEnvironment(vec![]),
                guard: Some(guard),
                assets: Some(f.reference.clone()),
            },
        )
        .unwrap();
    owner.detach(grant.generation()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1200));
    assert_eq!(owner.status().unwrap().state, State::Spawned);
    std::fs::write(f.root.join("index.html"), b"changed").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        if owner.status().unwrap().state == State::Exited {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let terminal = owner
        .terminal_status(&binding, &[7; 32], &Controller::current().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(terminal.state, State::Exited);
    assert!(!owner.present());
    assert!(
        !std::path::Path::new(&format!("/proc/{}", grant.snapshot.original_child_pid)).exists()
    );
}

#[test]
#[ignore = "explicit maximum-inventory performance measurement; not default small regression run"]
fn maximum_inventory_reports_admission_and_detached_poll_cost() {
    let mut f = Fixture::new();
    for index in 0..16383 {
        let path = f.root.join(format!("file-{index}.js"));
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let receipt_path = f
        .state
        .join("remote-mobile-runtime-v1")
        .join(format!("{}.receipt.json", f.reference.generation));
    let mut value: Value = serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    let mut entries = Vec::new();
    let root_stat = stat_value(&std::fs::symlink_metadata(&f.root).unwrap());
    let hex = |v: [u8; 32]| v.iter().map(|b| format!("{b:02x}")).collect::<String>();
    entries.push(
        json!({"kind":"directory","pathDigest":hex(model::path_digest(true,"")),"stat":root_stat}),
    );
    for item in std::fs::read_dir(&f.root).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().into_string().unwrap();
        let content = std::fs::read(item.path()).unwrap();
        entries.push(json!({"kind":"file","pathDigest":hex(model::path_digest(false,&name)),"stat":stat_value(&std::fs::symlink_metadata(item.path()).unwrap()),"sha256":format!("{:x}",Sha256::digest(&content))}));
    }
    entries.sort_by(|a, b| {
        a["pathDigest"]
            .as_str()
            .unwrap()
            .cmp(b["pathDigest"].as_str().unwrap())
    });
    value["entries"] = entries.into();
    let bytes = serde_json::to_vec(&value).unwrap();
    f.reference.size = bytes.len() as u64;
    f.reference.sha256 = Sha256::digest(&bytes).into();
    std::fs::write(&receipt_path, &bytes).unwrap();
    let start = std::time::Instant::now();
    let watch = f.reference.watch().unwrap();
    let admission = start.elapsed();
    let start = std::time::Instant::now();
    watch.check().unwrap();
    eprintln!(
        "16385-row receipt bytes={}; admission_ms={}; metadata_poll_ms={}",
        bytes.len(),
        admission.as_millis(),
        start.elapsed().as_millis()
    );
}
