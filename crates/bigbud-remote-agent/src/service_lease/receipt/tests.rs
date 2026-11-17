#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::store::CAPACITY;
use super::*;
use crate::service_lease::{Binding, Controller, Error};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::PathBuf;

fn controller(pid: u32, started: &str) -> Controller {
    Controller {
        pid,
        boot: "4f1c2f0e-boot".into(),
        started: started.into(),
    }
}
pub(in crate::service_lease) fn fixture(nonce: &str) -> Receipt {
    Receipt {
        revision: 1,
        binding: Binding {
            authority: "a".repeat(32),
            installation: format!("sha256:{}", "b".repeat(64)),
            native_epoch: "epoch".into(),
            nonce: nonce.into(),
            publication_sha256: [1; 32],
            executable_sha256: [2; 32],
            assets_sha256: [3; 32],
            configuration_sha256: [4; 32],
            guard_sha256: [5; 32],
        },
        original_controller: controller(40, "100"),
        controller: controller(40, "100"),
        child: controller(41, "101"),
        listener: Listener {
            address: "127.0.0.1:4774".parse().unwrap(),
            inode: 9001,
        },
        upstream: Some(Upstream {
            path: "/state/remote-mobile.sock".into(),
            socket: Some(SocketIdentity { dev: 7, ino: 8 }),
        }),
    }
}
struct Root(PathBuf);
impl Root {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bigbud-receipt-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn store(&self) -> Store {
        Store::new(self.0.join("receipts")).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _cleanup = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn receipt_round_trips_canonically_and_rejects_ambiguous_shapes() {
    let receipt = fixture("attempt-1");
    let bytes = receipt.encode().unwrap();
    assert_eq!(Receipt::parse(&bytes).unwrap(), receipt);
    assert_eq!(
        receipt.encode().unwrap(),
        bytes,
        "encoding is deterministic"
    );
    let text = String::from_utf8(bytes).unwrap();
    let duplicate = text.replacen("{", "{\"revision\":2,", 1);
    assert!(Receipt::parse(duplicate.as_bytes()).is_err());
    let extra = text.replacen("{", "{\"extra\":1,", 1);
    assert!(Receipt::parse(extra.as_bytes()).is_err());
    for (from, to) in [
        ("127.0.0.1:4774", "0.0.0.0:4774"),
        ("\"inode\":\"9001\"", "\"inode\":\"0\""),
        ("\"revision\":1", "\"revision\":0"),
        ("/state/remote-mobile.sock", "state/remote-mobile.sock"),
        ("/state/remote-mobile.sock", "/state/../remote-mobile.sock"),
        ("\"nonce\":\"attempt-1\"", "\"nonce\":\"../x/y\""),
    ] {
        assert!(
            Receipt::parse(text.replace(from, to).as_bytes()).is_err(),
            "{to}"
        );
    }
    assert!(Receipt::parse(&vec![b' '; 4097]).is_err());
    let mut detached = receipt;
    detached.upstream.as_mut().unwrap().socket = None;
    assert!(detached.attaching());
    assert_eq!(
        Receipt::parse(&detached.encode().unwrap()).unwrap(),
        detached
    );
    detached.upstream = None;
    assert!(!detached.attaching());
    assert_eq!(
        Receipt::parse(&detached.encode().unwrap()).unwrap(),
        detached
    );
}

#[test]
fn upstream_argument_is_single_absolute_and_unix_bounded() {
    let args = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        upstream_argument(&args(&["--upstream", "127.0.0.1:9"])).unwrap(),
        None
    );
    assert_eq!(
        upstream_argument(&args(&["--upstream-unix", "/s/remote-mobile.sock"])).unwrap(),
        Some(PathBuf::from("/s/remote-mobile.sock"))
    );
    for bad in [
        args(&["--upstream-unix"]),
        args(&["--upstream-unix", "relative.sock"]),
        args(&["--upstream-unix", "/s/../x.sock"]),
        args(&["--upstream-unix=/s/x.sock"]),
        args(&["--upstream-unix", "/a.sock", "--upstream-unix", "/b.sock"]),
    ] {
        assert!(upstream_argument(&bad).is_err(), "{bad:?}");
    }
    let long = format!("/{}", "x".repeat(107));
    assert!(upstream_argument(&args(&["--upstream-unix", &long])).is_err());
}

#[test]
fn store_writes_private_atomic_receipts_and_removes_only_the_exact_one() {
    let root = Root::new("write");
    let store = root.store();
    assert!(
        store.write(&fixture("attempt-1")).is_err(),
        "prepare creates the root"
    );
    store.prepare(|_| Ok(false)).unwrap();
    let info = std::fs::symlink_metadata(root.0.join("receipts")).unwrap();
    assert_eq!(info.mode() & 0o7777, 0o700);
    let mut receipt = fixture("attempt-1");
    store.write(&receipt).unwrap();
    assert_eq!(store.read("attempt-1").unwrap(), Some(receipt.clone()));
    assert_eq!(store.read("attempt-2").unwrap(), None);
    let files: Vec<_> = std::fs::read_dir(root.0.join("receipts"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "no temporary survives a successful write");
    assert_eq!(std::fs::metadata(&files[0]).unwrap().mode() & 0o7777, 0o600);
    receipt.revision = 2;
    receipt.upstream.as_mut().unwrap().socket = None;
    store.write(&receipt).unwrap();
    assert_eq!(store.read("attempt-1").unwrap(), Some(receipt.clone()));
    let mut stale = receipt.clone();
    stale.revision = 1;
    assert!(matches!(store.remove(&stale), Err(Error::Uncertain)));
    assert!(
        store.read("attempt-1").unwrap().is_some(),
        "changed receipt is preserved"
    );
    store.remove(&receipt).unwrap();
    assert_eq!(store.read("attempt-1").unwrap(), None);
    store.remove(&receipt).unwrap();
}

#[test]
fn store_refuses_substituted_or_linked_receipt_files() {
    let root = Root::new("substitute");
    let store = root.store();
    store.prepare(|_| Ok(false)).unwrap();
    let receipt = fixture("attempt-1");
    store.write(&receipt).unwrap();
    let path = std::fs::read_dir(root.0.join("receipts"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.read("attempt-1").is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = root.0.join("hard-link");
    std::fs::hard_link(&path, &link).unwrap();
    assert!(store.read("attempt-1").is_err(), "nlink must be one");
    std::fs::remove_file(&link).unwrap();
    let target = root.0.join("target.json");
    std::fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert!(
        store.read("attempt-1").is_err(),
        "symlinked receipt is refused"
    );
    assert!(
        store.remove(&receipt).is_err(),
        "symlink is never followed or removed"
    );
    assert!(std::fs::symlink_metadata(&path).is_ok());
}

#[test]
fn prepare_prunes_only_dead_children_and_bounds_retention() {
    let root = Root::new("prune");
    let store = root.store();
    store.prepare(|_| Ok(false)).unwrap();
    std::fs::write(root.0.join("receipts/.orphan-1.tmp"), b"partial").unwrap();
    for index in 0..CAPACITY {
        store.write(&fixture(&format!("attempt-{index}"))).unwrap();
    }
    assert!(matches!(store.prepare(|_| Ok(false)), Err(Error::Occupied)));
    assert!(!root.0.join("receipts/.orphan-1.tmp").exists());
    assert!(store.prepare(|_| Err(Error::Uncertain)).is_err());
    store
        .prepare(|r| Ok(r.binding.nonce == "attempt-0"))
        .unwrap();
    assert_eq!(store.read("attempt-0").unwrap(), None);
    assert!(store.read("attempt-1").unwrap().is_some());
}
