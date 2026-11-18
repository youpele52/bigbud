#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use super::*;
use crate::backend_service::tests::fixture::{Fixture, mode, write};
use serde_json::{Value, json};
use std::cell::Cell;
use std::fs;
use std::path::PathBuf;

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn graph_receipt(root: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let graph = fs::metadata(root).unwrap();
    let mut body = format!(
        "bigbud-backend-graph-receipt=1\nroot={}\nroot_dev={}\nroot_ino={}\nroot_ctime_ns={}\nmanifest_sha256={}\nnode=node\nentry=backend.mjs\n",
        root.display(),
        graph.dev(),
        graph.ino(),
        i128::from(graph.ctime()) * 1_000_000_000 + i128::from(graph.ctime_nsec()),
        "e".repeat(64)
    );
    for (name, mode) in [("backend.mjs", "600"), ("node", "700")] {
        let bytes = fs::read(root.join(name)).unwrap();
        body.push_str(&format!(
            "file={}\t{}\t{mode}\t{name}\n",
            sha(&bytes),
            bytes.len()
        ));
    }
    body
}

/// A service on its previous graph, a staged new graph and a `restarting` journal.
struct Update {
    f: Fixture,
    old_text: String,
    old_receipt: Vec<u8>,
    new: ServiceConfig,
    new_receipt: String,
    dir: PathBuf,
}

impl Update {
    fn new() -> Self {
        let f = Fixture::new();
        let old_text = fs::read_to_string(f.config.config_path()).unwrap();
        let old_receipt = fs::read(f.config.receipt_path()).unwrap();
        let root = f.root.join("graph2");
        fs::create_dir(&root).unwrap();
        mode(&root, 0o700);
        write(&root.join("node"), b"#!/bin/sh\nexit 3\n", 0o700);
        write(&root.join("backend.mjs"), b"// new entry\n", 0o600);
        let new_receipt = graph_receipt(&root);
        let mut new = f.config.clone();
        new.node_binary = root.join("node");
        new.node_sha256 = sha(b"#!/bin/sh\nexit 3\n");
        new.backend_entry = root.join("backend.mjs");
        new.backend_sha256 = sha(b"// new entry\n");
        new.receipt_sha256 = sha(new_receipt.as_bytes());
        let dir = journal::update_dir(&f.config);
        for path in [dir.parent().unwrap(), dir.as_path()] {
            fs::create_dir(path).unwrap();
            mode(path, 0o700);
        }
        let update = Self {
            f,
            old_text,
            old_receipt,
            new,
            new_receipt,
            dir,
        };
        update.journal("restarting", Value::Null);
        update
    }
    fn journal(&self, phase: &str, failure: Value) {
        let value = json!({
            "revision": 1, "operationId": "0b9f-op", "archiveKey": "key", "phase": phase,
            "backupPath": "/backup.sqlite", "previousConfig": self.old_text,
            "previousReceipt": String::from_utf8(self.old_receipt.clone()).unwrap(),
            "failure": failure, "uncertain": ["thread-1"],
        });
        write(
            &self.dir.join("activation-v1.json"),
            format!("{value}\n").as_bytes(),
            0o600,
        );
    }
    fn write_receipt(&self, bytes: &[u8]) {
        write(&self.f.config.receipt_path(), bytes, 0o600);
    }
    fn write_config(&self, config: &ServiceConfig) {
        write(
            &self.f.config.config_path(),
            config.encode().unwrap().as_bytes(),
            0o600,
        );
    }
    /// The backend's switch: receipt first, then config.
    fn switch(&self) {
        self.write_receipt(self.new_receipt.as_bytes());
        self.write_config(&self.new);
    }
    fn launch(&self) -> (Result<ServiceConfig>, u32) {
        let fenced = Cell::new(0);
        let config = ServiceConfig::definition(&self.f.config.config_path()).unwrap();
        let result = reconcile(config, |_| {
            fenced.set(fenced.get() + 1);
            Ok(())
        });
        (result, fenced.get())
    }
    fn stored(&self) -> Value {
        serde_json::from_slice(&fs::read(self.dir.join("activation-v1.json")).unwrap()).unwrap()
    }
    fn snapshot(&self) -> [Vec<u8>; 3] {
        [
            fs::read(self.f.config.config_path()).unwrap(),
            fs::read(self.f.config.receipt_path()).unwrap(),
            fs::read(self.dir.join("activation-v1.json")).unwrap(),
        ]
    }
    fn assert_restored(&self, restored: &ServiceConfig, failure: &str) {
        assert_eq!(*restored, self.f.config);
        restored.validate().unwrap();
        assert_eq!(
            fs::read(self.f.config.receipt_path()).unwrap(),
            self.old_receipt
        );
        let journal = self.stored();
        assert_eq!(journal["phase"], "restore-pending");
        assert_eq!(journal["failure"], failure);
        // Every other field is kept exactly as the backend wrote it.
        assert_eq!(journal["uncertain"], json!(["thread-1"]));
        assert_eq!(journal["backupPath"], "/backup.sqlite");
        assert!(!self.dir.join("launch-attempts-v1").exists());
        assert!(
            !self
                .f
                .config
                .config_dir()
                .join(".artifact-receipt.rollback")
                .exists()
        );
    }
}

#[test]
fn journal_parsing_accepts_only_the_backend_format() {
    let u = Update::new();
    let journal = journal::read(&u.dir).unwrap().unwrap();
    assert_eq!(
        (journal.operation_id.as_str(), journal.phase.as_str()),
        ("0b9f-op", "restarting")
    );
    assert_eq!(journal.previous_config, u.old_text);
    for broken in [
        "[]".to_owned(),
        "{\"revision\":2}".to_owned(),
        u.stored()
            .to_string()
            .replace("\"0b9f-op\"", "\"../escape\""),
        u.stored()
            .to_string()
            .replace("\"failure\":null", "\"failure\":7"),
        "not json".to_owned(),
    ] {
        write(&u.dir.join("activation-v1.json"), broken.as_bytes(), 0o600);
        assert!(journal::read(&u.dir).is_err(), "{broken}");
        // An unusable journal is preserved, and the configured runtime launches as before.
        let (launched, fenced) = u.launch();
        assert_eq!(launched.unwrap(), u.f.config);
        assert_eq!(fenced, 0);
        assert_eq!(
            fs::read(u.dir.join("activation-v1.json")).unwrap(),
            broken.as_bytes()
        );
    }
    fs::remove_file(u.dir.join("activation-v1.json")).unwrap();
    assert!(journal::read(&u.dir).unwrap().is_none());
}

#[test]
fn attempts_count_per_operation_and_runtime() {
    let u = Update::new();
    let receipt = &u.new.receipt_sha256;
    assert_eq!(journal::bump_attempts(&u.dir, "op-a", receipt).unwrap(), 1);
    assert_eq!(journal::bump_attempts(&u.dir, "op-a", receipt).unwrap(), 2);
    assert_eq!(journal::bump_attempts(&u.dir, "op-b", receipt).unwrap(), 1);
    assert_eq!(
        journal::bump_attempts(&u.dir, "op-b", &"f".repeat(64)).unwrap(),
        1
    );
    write(&u.dir.join("launch-attempts-v1"), b"garbage", 0o600);
    assert_eq!(journal::bump_attempts(&u.dir, "op-b", receipt).unwrap(), 1);
    journal::clear_attempts(&u.dir).unwrap();
    journal::clear_attempts(&u.dir).unwrap();
    assert_eq!(journal::bump_attempts(&u.dir, "op-b", receipt).unwrap(), 1);
}

#[test]
fn switched_runtime_rolls_back_after_bounded_failed_launches() {
    let u = Update::new();
    u.switch();
    for attempt in 1..=MAX_FAILED_LAUNCHES {
        let (launched, fenced) = u.launch();
        assert_eq!(
            launched.unwrap(),
            u.new,
            "launch {attempt} keeps the new runtime"
        );
        assert_eq!(fenced, 1);
        assert_eq!(u.stored()["phase"], "restarting");
    }
    let (restored, _) = u.launch();
    u.assert_restored(
        &restored.unwrap(),
        "The new runtime did not start after 3 launches; the launcher restored the previous runtime.",
    );
    // The previous runtime launches as configured from now on, without counting.
    let (again, fenced) = u.launch();
    assert_eq!(again.unwrap(), u.f.config);
    assert_eq!(fenced, 0);
}

#[test]
fn half_switched_pair_restores_the_previous_runtime() {
    let u = Update::new();
    // The backend renamed the new receipt, then stopped before the config.
    u.write_receipt(u.new_receipt.as_bytes());
    assert!(u.f.config.validate().is_err());
    let (restored, fenced) = u.launch();
    assert_eq!(fenced, 1);
    u.assert_restored(&restored.unwrap(), HALF_SWITCHED);
}

#[test]
fn consistent_previous_runtime_launches_without_counting() {
    let u = Update::new();
    let before = u.snapshot();
    let (launched, fenced) = u.launch();
    assert_eq!(launched.unwrap(), u.f.config);
    assert_eq!(fenced, 0);
    assert_eq!(u.snapshot(), before);
    assert!(!u.dir.join("launch-attempts-v1").exists());
}

#[test]
fn verifier_failure_leaves_config_receipt_and_journal_untouched() {
    let u = Update::new();
    u.switch();
    // The previous Node no longer matches its pinned mode.
    mode(&u.f.config.node_binary, 0o600);
    for _ in 0..MAX_FAILED_LAUNCHES {
        assert!(u.launch().0.is_ok());
    }
    let before = u.snapshot();
    assert!(u.launch().0.is_err());
    assert_eq!(u.snapshot(), before);
    assert_eq!(u.stored()["phase"], "restarting");
    assert!(
        !u.f.config
            .config_dir()
            .join(".artifact-receipt.rollback")
            .exists()
    );
    // Repaired, the next launch completes the rollback.
    mode(&u.f.config.node_binary, 0o700);
    let (restored, _) = u.launch();
    assert_eq!(restored.unwrap(), u.f.config);
}

#[test]
fn interrupted_rollback_is_finished_with_its_reason() {
    let u = Update::new();
    u.journal(
        "rollback",
        json!("The new runtime did not become ready in time."),
    );
    // Stopped between the receipt and config renames of the restore.
    u.write_config(&u.new);
    let (restored, fenced) = u.launch();
    assert_eq!(fenced, 1);
    u.assert_restored(
        &restored.unwrap(),
        "The new runtime did not become ready in time.",
    );
}

#[test]
fn other_phases_foreign_previous_and_fence_refusal_change_nothing() {
    let u = Update::new();
    u.switch();
    for phase in ["restore-pending", "restored"] {
        u.journal(phase, json!("reason"));
        let (launched, fenced) = u.launch();
        assert_eq!((launched.unwrap(), fenced), (u.new.clone(), 0));
    }
    // A previous config of another service is never restored.
    let foreign = u.old_text.replace(&u.f.config.authority, &"b".repeat(32));
    let value = json!({
        "revision": 1, "operationId": "0b9f-op", "archiveKey": "key", "phase": "restarting",
        "backupPath": "/b", "previousConfig": foreign,
        "previousReceipt": String::from_utf8(u.old_receipt.clone()).unwrap(),
        "failure": null, "uncertain": [],
    });
    write(
        &u.dir.join("activation-v1.json"),
        value.to_string().as_bytes(),
        0o600,
    );
    for _ in 0..=MAX_FAILED_LAUNCHES {
        assert_eq!(u.launch().0.unwrap(), u.new);
    }
    assert!(!u.dir.join("launch-attempts-v1").exists());
    // Only the managed unit itself may count or restore.
    u.journal("restarting", Value::Null);
    let before = u.snapshot();
    let config = ServiceConfig::definition(&u.f.config.config_path()).unwrap();
    assert!(reconcile(config, |_| Err(ServiceError::Manager)).is_err());
    assert_eq!(u.snapshot(), before);
    assert!(!u.dir.join("launch-attempts-v1").exists());
}

#[test]
fn encoded_config_uses_the_backend_key_order_and_round_trips() {
    let u = Update::new();
    let text = u.new.encode().unwrap();
    assert_eq!(ServiceConfig::parse(&text).unwrap(), u.new);
    let keys: Vec<_> = text
        .lines()
        .map(|line| line.split('=').next().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "version",
            "authority",
            "home",
            "backend_home",
            "rust_binary",
            "rust_sha256",
            "rust_state",
            "node_binary",
            "node_sha256",
            "backend_entry",
            "backend_sha256",
            "receipt_sha256",
            "restart",
            "launch_attempt",
            "prior_epoch",
            "launch_boot",
            "expected_installation_fingerprint",
            "authority_reservation_sha256",
        ]
    );
}
