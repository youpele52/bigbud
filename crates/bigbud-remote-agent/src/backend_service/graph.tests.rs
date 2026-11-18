#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::{
    ServiceRole,
    tests::fixture::{Fixture, mode, write},
};
use std::{fs, os::unix::fs::symlink};
fn receipt(f: &mut Fixture) {
    let root = f.config.node_binary.parent().unwrap();
    let mut paths = Vec::new();
    let mut stack = vec![root.to_owned()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                paths.push(path);
            }
        }
    }
    paths.sort();
    let mut body = format!(
        "bigbud-backend-graph-receipt=1\nroot={}\nmanifest_sha256={}\nnode=node\nentry=backend.mjs\n",
        root.display(),
        "d".repeat(64)
    );
    for path in paths {
        use std::os::unix::fs::MetadataExt;
        let bytes = fs::read(&path).unwrap();
        body.push_str(&format!(
            "file={:x}\t{}\t{:o}\t{}\n",
            Sha256::digest(&bytes),
            bytes.len(),
            fs::metadata(&path).unwrap().mode() & 0o7777,
            path.strip_prefix(root).unwrap().to_str().unwrap()
        ));
    }
    use std::os::unix::fs::MetadataExt;
    let graph = fs::metadata(root).unwrap();
    body = body.replacen(
        "manifest_sha256=",
        &format!(
            "root_dev={}\nroot_ino={}\nroot_ctime_ns={}\nmanifest_sha256=",
            graph.dev(),
            graph.ino(),
            i128::from(graph.ctime()) * 1_000_000_000 + i128::from(graph.ctime_nsec())
        ),
        1,
    );
    f.config.receipt_sha256 = format!("{:x}", Sha256::digest(body.as_bytes()));
    write(&f.config.receipt_path(), body.as_bytes(), 0o600);
}
#[test]
fn chunk_only_tamper_cannot_execute_before_node_or_capability_probe() {
    let mut f = Fixture::new();
    let root = f.config.node_binary.parent().unwrap().to_owned();
    let marker = f.root.join("unexpected-execution");
    let node = b"#!/bin/sh\nexec /bin/sh \"$1\"\n";
    let entry = b". \"$(dirname \"$0\")/chunk.sh\"\n";
    write(&f.config.node_binary, node, 0o700);
    write(&f.config.backend_entry, entry, 0o600);
    write(&root.join("chunk.sh"), b": # admitted chunk\n", 0o600);
    f.config.node_sha256 = format!("{:x}", Sha256::digest(node));
    f.config.backend_sha256 = format!("{:x}", Sha256::digest(entry));
    receipt(&mut f);
    assert!(
        f.config
            .command(ServiceRole::Backend)
            .unwrap()
            .status()
            .unwrap()
            .success()
    );
    write(
        &root.join("chunk.sh"),
        format!("printf bad > '{}'\n", marker.display()).as_bytes(),
        0o600,
    );
    let rejected = match f.config.command(ServiceRole::Backend) {
        Ok(mut command) => {
            assert!(command.status().unwrap().success());
            false
        }
        Err(_) => true,
    };
    assert!(
        !marker.exists(),
        "a changed imported chunk executed before graph admission"
    );
    assert!(rejected);
    let manager = crate::backend_service::tests::fixture::FakeManager::default();
    assert!(
        crate::backend_service::enable::enable(
            &f.config,
            &manager,
            crate::backend_service::Prerequisites::Ready
        )
        .is_err()
    );
    assert!(manager.calls.borrow().is_empty());
    assert!(!marker.exists());
    assert!(f.config.validate_role(ServiceRole::Rust).is_ok());
}
#[test]
fn exact_membership_rejects_extra_missing_worker_and_native_sidecar_changes() {
    for case in [
        "extra",
        "missing",
        "worker",
        "native",
        "mode",
        "link",
        "hardlink",
        "empty-directory",
    ] {
        let mut f = Fixture::new();
        let root = f.config.node_binary.parent().unwrap().to_owned();
        let worker = root.join("worker.mjs");
        let native = root.join("native.node");
        fs::create_dir(root.join("nested")).unwrap();
        mode(&root.join("nested"), 0o700);
        write(&root.join("nested/chunk.mjs"), b"nested", 0o600);
        write(&worker, b"worker", 0o600);
        write(&native, b"native", 0o700);
        receipt(&mut f);
        assert!(verify(&f.config).is_ok());
        match case {
            "extra" => write(&root.join("extra"), b"undeclared", 0o600),
            "missing" => fs::remove_file(&worker).unwrap(),
            "worker" => write(&worker, b"changed", 0o600),
            "native" => write(&native, b"changed", 0o700),
            "mode" => mode(&worker, 0o644),
            "link" => {
                fs::remove_file(&worker).unwrap();
                symlink(&native, &worker).unwrap();
            }
            "empty-directory" => {
                fs::create_dir(root.join("nested/undeclared-empty")).unwrap();
                mode(&root.join("nested/undeclared-empty"), 0o700);
            }
            _ => {
                assert_eq!(case, "hardlink");
                fs::hard_link(&worker, root.join("alias")).unwrap();
            }
        }
        assert!(verify(&f.config).is_err(), "case {case}");
    }
}
#[test]
fn receipt_rejects_legacy_bounds_paths_unsorted_and_config_pin_mismatch() {
    let f = Fixture::new();
    let original = fs::read_to_string(f.config.receipt_path()).unwrap();
    for text in [
        "legacy opaque receipt".into(),
        original.replace("node=node", "node=../node"),
        original.replace("\t700\tnode", "\t755\tnode"),
        original.replace("manifest_sha256=", "unknown="),
        original.replace("\t600\tbackend.mjs", "\t600\t../backend.mjs"),
        original.replace("file=", "bad="),
        original.replace("\t600\tbackend.mjs", "\t600\tnode"),
        original.replace("\tnode\n", "\tnode\n\n"),
    ] {
        write(&f.config.receipt_path(), text.as_bytes(), 0o600);
        let mut config = f.config.clone();
        config.receipt_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
        assert!(verify(&config).is_err());
    }
    write(&f.config.receipt_path(), original.as_bytes(), 0o600);
    let mut wrong = f.config.clone();
    wrong.node_sha256 = "0".repeat(64);
    assert!(verify(&wrong).is_err());
    let header = original
        .lines()
        .take_while(|line| !line.starts_with("file="))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut huge = header.clone();
    for n in 0..=MAX_FILES {
        huge.push_str(&format!("file={}\t0\t600\tm{n:05}\n", "a".repeat(64)));
    }
    write(&f.config.receipt_path(), huge.as_bytes(), 0o600);
    let mut wrong = f.config.clone();
    wrong.receipt_sha256 = format!("{:x}", Sha256::digest(huge.as_bytes()));
    assert!(
        verify(&wrong)
            .unwrap_err()
            .to_string()
            .contains("file budget")
    );
    let oversized = header + &format!("file={}\t{}\t600\tmember\n", "a".repeat(64), MAX_BYTES + 1);
    write(&f.config.receipt_path(), oversized.as_bytes(), 0o600);
    wrong.receipt_sha256 = format!("{:x}", Sha256::digest(oversized.as_bytes()));
    assert!(
        verify(&wrong)
            .unwrap_err()
            .to_string()
            .contains("byte budget")
    );
}

#[test]
fn replaced_graph_root_is_not_adopted_despite_identical_member_content() {
    let f = Fixture::new();
    let root = f.config.node_binary.parent().unwrap();
    let old = f.root.join("prior-graph");
    fs::rename(root, &old).unwrap();
    fs::create_dir(root).unwrap();
    mode(root, 0o700);
    for entry in fs::read_dir(old).unwrap() {
        let path = entry.unwrap().path();
        let target = root.join(path.file_name().unwrap());
        write(
            &target,
            &fs::read(&path).unwrap(),
            if path.file_name().unwrap() == "node" {
                0o700
            } else {
                0o600
            },
        );
    }
    assert!(verify(&f.config).is_err());
}

#[test]
fn graphless_service2_artifact_cannot_stage_or_enable_backend_units() {
    use crate::backend_service::{Prerequisites, cli, tests::fixture::FakeManager};
    let f = Fixture::new();
    for operation in ["stage", "enable"] {
        let manager = FakeManager {
            service_graphless: true,
            ..Default::default()
        };
        assert!(cli::apply(&f.config, operation, true, &manager, Prerequisites::Ready).is_err());
        assert_eq!(manager.calls.borrow().len(), 1);
        assert!(
            manager
                .calls
                .borrow()
                .iter()
                .all(|(program, _)| program.ends_with("bigbud-remote-agent"))
        );
    }
    let manager = FakeManager {
        service_graphless: true,
        ..Default::default()
    };
    // Rust-only P4 ownership still accepts protocol2 independently of backend graph support.
    assert!(cli::require_capability(&f.config, &manager, false).is_ok());
    assert!(cli::require_capability(&f.config, &manager, true).is_err());
}
