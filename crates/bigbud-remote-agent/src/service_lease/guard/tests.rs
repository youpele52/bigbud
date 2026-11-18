#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
use super::read::{Observation, Reader};
use super::*;
use serde_json::json;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: std::path::PathBuf,
    guard: Guard,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "lease-guard-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = std::fs::canonicalize(path).unwrap();
        let metadata = std::fs::metadata(&root).unwrap();
        let value = json!({"version":1,"file":root.join("registry.json"),"anchors":[{"path":root,
            "dev":metadata.dev().to_string(),"ino":metadata.ino().to_string(),"uid":metadata.uid().to_string(),"mode":448}],
            "all":[{"path":["mobile","consent","enabled"],"values":[true]},
                {"path":["mobile","consent","revision"],"values":[1]}],
            "select":[{"path":["mobile","attempts"],"key":"nonce","value":"original",
                "all":[{"path":["phase"],"values":["attempted","child-owned"]}]}]});
        let guard = Guard::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        Self { root, guard }
    }
    fn write(&self, enabled: bool, connection: &str) {
        let temp = self.root.join("next");
        let data=serde_json::to_vec(&json!({"mobile":{"consent":{"enabled":enabled,"revision":1},
            "attempts":[{"nonce":"unrelated","phase":"exit-confirmed"},{"nonce":"original","phase":"child-owned"}]},
            "connection":connection})).unwrap();
        std::fs::write(&temp, data).unwrap();
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(temp, &self.guard.model.file).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn mechanical_leaf_survives_unrelated_atomic_writes_but_durable_off_invalidates() {
    let f = Fixture::new();
    let mut reader = Reader::default();
    f.write(true, "connection-a");
    assert!(matches!(reader.check(&f.guard), Observation::Valid));
    assert!(matches!(reader.check(&f.guard), Observation::Valid));
    f.write(true, "connection-b");
    assert!(matches!(reader.check(&f.guard), Observation::Valid));
    f.write(false, "connection-c");
    assert!(matches!(reader.check(&f.guard), Observation::Invalid));
}
#[test]
fn unique_nonce_selector_never_depends_on_array_position_or_accepts_duplicate_branches() {
    let f = Fixture::new();
    let value=br#"{"mobile":{"attempts":[{"nonce":"original","phase":"attempted"}],"consent":{"enabled":true,"revision":1}}}"#;
    assert!(f.guard.evaluate(value).unwrap());
    let duplicate=br#"{"mobile":{},"mobile":{"attempts":[{"nonce":"original","phase":"attempted"}],"consent":{"enabled":true,"revision":1}}}"#;
    assert!(f.guard.evaluate(duplicate).is_err());
    let duplicate_nonce=br#"{"mobile":{"attempts":[{"nonce":"original","phase":"attempted"},{"nonce":"original","phase":"attempted"}],"consent":{"enabled":true,"revision":1}}}"#;
    assert!(!f.guard.evaluate(duplicate_nonce).unwrap());
}
#[test]
fn malformed_or_replaced_registry_and_root_never_reuse_cached_validity() {
    let f = Fixture::new();
    f.write(true, "a");
    let mut reader = Reader::default();
    assert!(matches!(reader.check(&f.guard), Observation::Valid));
    std::fs::write(&f.guard.model.file, b"{").unwrap();
    assert!(matches!(reader.check(&f.guard), Observation::Invalid));
    f.write(true, "b");
    assert!(matches!(reader.check(&f.guard), Observation::Valid));
    let old = f.root.with_extension("original");
    std::fs::rename(&f.root, &old).unwrap();
    std::fs::create_dir(&f.root).unwrap();
    std::fs::set_permissions(&f.root, std::fs::Permissions::from_mode(0o700)).unwrap();
    f.write(true, "copy");
    assert!(matches!(reader.check(&f.guard), Observation::Invalid));
    std::fs::remove_dir_all(old).unwrap();
}
fn peak_rss() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: correctly sized writable initialized storage for this process's resource counters.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    // SAFETY: successful getrusage initialized the structure.
    let usage = unsafe { usage.assume_init() };
    let value = u64::try_from(usage.ru_maxrss).unwrap();
    if cfg!(target_os = "linux") {
        value * 1024
    } else {
        value
    }
}
#[test]
fn huge_irrelevant_array_has_bounded_projection_memory_and_token_budget() {
    let f = Fixture::new();
    let mut bytes = String::from("{\"irrelevant\":[");
    bytes.push_str(&"0,".repeat(6_000_000));
    bytes.push_str("0]}");
    assert!(bytes.len() < 16 * 1024 * 1024);
    let before = peak_rss();
    assert!(f.guard.evaluate(bytes.as_bytes()).is_err());
    let delta = peak_rss().saturating_sub(before);
    eprintln!(
        "guard projection RSS growth bytes: {delta}; source bytes: {}",
        bytes.len()
    );
    assert!(
        delta < 64 * 1024 * 1024,
        "a guard must not retain a whole irrelevant JSON tree"
    );
}

#[test]
fn computed_self_hashes_bind_only_after_raw_guard_and_private_body_exist() {
    let f = Fixture::new();
    let mut value: serde_json::Value = serde_json::from_slice(f.guard.bytes()).unwrap();
    value["version"] = 2.into();
    value["all"] = json!([
        {"path":["configuration"],"valueFrom":"configurationSha256"},
        {"path":["guard"],"valueFrom":"guardSha256"}]);
    value["select"] = json!([]);
    let raw = serde_json::to_vec(&value).unwrap();
    let guard = Guard::parse(&raw).unwrap();
    let source=serde_json::to_vec(&json!({"configuration":"07".repeat(32),"guard":guard.digest().iter().map(|v|format!("{v:02x}")).collect::<String>()})).unwrap();
    assert!(
        guard.evaluate(&source).is_err(),
        "unbound origin labels are never permissive"
    );
    let bound = guard.bind_configuration([7; 32]);
    assert_eq!(bound.bytes(), raw);
    assert_eq!(bound.digest(), guard.digest());
    assert!(bound.evaluate(&source).unwrap());
    assert!(!guard.bind_configuration([8; 32]).evaluate(&source).unwrap());
    value["version"] = 1.into();
    assert!(Guard::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    value["version"] = 2.into();
    value["all"] = json!([{"path":["guard"],"valueFrom":"callerBoolean"}]);
    assert!(Guard::parse(&serde_json::to_vec(&value).unwrap()).is_err());
}
#[test]
fn bounded_pin_selector_tolerates_128_unrelated_reordered_rows_without_index_pinning() {
    let f = Fixture::new();
    let mut value: serde_json::Value = serde_json::from_slice(f.guard.bytes()).unwrap();
    value["version"] = 2.into();
    value["all"] = json!([{"path":["version"],"values":[3]}]);
    value["select"] = json!([{"path":["pins"],"key":"owner","value":"original","maxRows":128,"all":[{"path":["buildId"],"values":["pinned"]}]}]);
    let guard = Guard::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    let mut pins = (0..127)
        .map(|i| json!({"owner":format!("other-{i}"),"buildId":"other"}))
        .collect::<Vec<_>>();
    pins.push(json!({"owner":"original","buildId":"pinned"}));
    assert!(
        guard
            .evaluate(&serde_json::to_vec(&json!({"version":3,"pins":pins})).unwrap())
            .unwrap()
    );
    pins.reverse();
    assert!(
        guard
            .evaluate(&serde_json::to_vec(&json!({"version":3,"pins":pins})).unwrap())
            .unwrap()
    );
    pins.push(json!({"owner":"excess","buildId":"other"}));
    assert!(
        guard
            .evaluate(&serde_json::to_vec(&json!({"version":3,"pins":pins})).unwrap())
            .is_err()
    );
}

#[test]
fn guard_v2_matches_actual_typescript_encoder_and_computed_cas_leaf_golden() {
    let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/remote-agent/service_lease.guard-v2.golden.json"
    )))
    .unwrap();
    let raw = value["rawUtf8"].as_str().unwrap().as_bytes();
    let guard = Guard::parse(raw).unwrap();
    assert_eq!(
        guard
            .digest()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        value["guardSha256"].as_str().unwrap()
    );
    let source = serde_json::to_vec(&value["source"]).unwrap();
    assert!(guard.evaluate(&source).is_err());
    let bound = guard.bind_configuration([7; 32]);
    assert!(bound.evaluate(&source).unwrap());
    let mut invalid = value["source"].clone();
    invalid["mobile"]["gatewayLifecycle"]["attempts"][1]["nativeOwnership"]["binding"]["configurationSha256"] =
        "bad".into();
    assert!(
        !bound
            .evaluate(&serde_json::to_vec(&invalid).unwrap())
            .unwrap()
    );
}
