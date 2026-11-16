use super::{Manager, Result, ServiceConfig, ServiceError};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(unix)]
pub(crate) fn mode(path: &Path, permissions: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(permissions)).unwrap();
}
#[cfg(not(unix))]
pub(crate) fn mode(_path: &Path, _permissions: u32) {}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn write(path: &Path, bytes: &[u8], permissions: u32) {
    fs::write(path, bytes).unwrap();
    mode(path, permissions);
}
pub(crate) struct Fixture {
    pub(crate) config: ServiceConfig,
    pub(crate) root: PathBuf,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "bigbud-service-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        mode(&root, 0o700);
        let authority = "a".repeat(32);
        let bytes = b"fixture-only artifact; validation must never execute it\n";
        let rust_sha256 = digest(bytes);
        let rust_binary = root
            .join(".bigbud/agent/bin/1.0.0")
            .join(&rust_sha256)
            .join("bigbud-remote-agent");
        let mut config = ServiceConfig {
            authority,
            home: root.clone(),
            backend_home: root.join("backend-data"),
            rust_binary,
            rust_sha256,
            rust_state: root.join(".bigbud/agent/runtimes/g-fixture"),
            node_binary: root.join("graph/node"),
            node_sha256: digest(bytes),
            backend_entry: root.join("graph/backend.mjs"),
            backend_sha256: digest(bytes),
            receipt_sha256: digest(b"test verified-installer receipt"),
            expected_installation_fingerprint: format!("sha256:{}", "c".repeat(64)),
            authority_reservation_sha256: "0".repeat(64),
            restart: true,
            launch_attempt: "fixture-attempt".into(),
            prior_epoch: "fresh".into(),
            launch_boot: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
        };
        for directory in [
            root.join("graph"),
            config.config_dir(),
            config.rust_binary.parent().unwrap().to_owned(),
            config.rust_state.clone(),
            config.backend_home.clone(),
            config.backend_home.join("state"),
        ] {
            fs::create_dir_all(&directory).unwrap();
            let mut parent = Some(directory.as_path());
            while let Some(path) = parent {
                mode(path, 0o700);
                if path == root {
                    break;
                }
                parent = path.parent();
            }
        }
        write(&config.rust_binary, bytes, 0o700);
        write(&config.node_binary, bytes, 0o700);
        write(&config.backend_entry, bytes, 0o600);
        let receipt = format!(
            "bigbud-backend-graph-receipt=1\nroot={}\nmanifest_sha256={}\nnode=node\nentry=backend.mjs\nfile={}\t{}\t600\tbackend.mjs\nfile={}\t{}\t700\tnode\n",
            root.join("graph").display(),
            "d".repeat(64),
            config.backend_sha256,
            bytes.len(),
            config.node_sha256,
            bytes.len()
        );
        #[cfg(unix)]
        let receipt = {
            use std::os::unix::fs::MetadataExt;
            let graph = fs::metadata(root.join("graph")).unwrap();
            receipt.replacen(
                "manifest_sha256=",
                &format!(
                    "root_dev={}\nroot_ino={}\nroot_ctime_ns={}\nmanifest_sha256=",
                    graph.dev(),
                    graph.ino(),
                    i128::from(graph.ctime()) * 1_000_000_000 + i128::from(graph.ctime_nsec())
                ),
                1,
            )
        };
        config.receipt_sha256 = digest(receipt.as_bytes());
        write(&config.receipt_path(), receipt.as_bytes(), 0o600);
        write(&config.token_path(), b"fixture-secret-not-in-argv", 0o600);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let agent = config.home.join(".bigbud/agent");
            let agent_stat = fs::metadata(&agent).unwrap();
            let base_stat = fs::metadata(&config.backend_home).unwrap();
            let state = config.backend_home.join("state");
            let state_stat = fs::metadata(&state).unwrap();
            let fingerprint = super::super::authority::root_fingerprint(
                agent.to_str().unwrap(),
                agent_stat.uid(),
                agent_stat.dev(),
                agent_stat.ino(),
                &config.authority,
                &config.expected_installation_fingerprint,
            );
            let record = format!(
                "version=1\nauthority={}\ninstallation={}\nagent_root={}\nbackend_home={}\nbackend_home_dev={}\nbackend_home_ino={}\nbackend_state={}\nbackend_state_dev={}\nbackend_state_ino={}\n",
                config.authority,
                config.expected_installation_fingerprint,
                fingerprint,
                config.backend_home.display(),
                base_stat.dev(),
                base_stat.ino(),
                state.display(),
                state_stat.dev(),
                state_stat.ino()
            );
            write(
                &agent.join("account-authority-v1"),
                record.as_bytes(),
                0o600,
            );
            config.authority_reservation_sha256 = digest(record.as_bytes());
        }
        let fixture = Self { config, root };
        write(
            &fixture.config.config_path(),
            fixture.text().as_bytes(),
            0o600,
        );
        fixture
    }
    pub(crate) fn text(&self) -> String {
        let c = &self.config;
        format!(
            "version=1\nauthority={}\nhome={}\nbackend_home={}\nrust_binary={}\nrust_sha256={}\nrust_state={}\nnode_binary={}\nnode_sha256={}\nbackend_entry={}\nbackend_sha256={}\nreceipt_sha256={}\nrestart={}\nexpected_installation_fingerprint={}\nauthority_reservation_sha256={}\nlaunch_attempt={}\nprior_epoch={}\nlaunch_boot={}\n",
            c.authority,
            c.home.display(),
            c.backend_home.display(),
            c.rust_binary.display(),
            c.rust_sha256,
            c.rust_state.display(),
            c.node_binary.display(),
            c.node_sha256,
            c.backend_entry.display(),
            c.backend_sha256,
            c.receipt_sha256,
            if c.restart { "yes" } else { "no" },
            c.expected_installation_fingerprint,
            c.authority_reservation_sha256,
            c.launch_attempt,
            c.prior_epoch,
            c.launch_boot
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[derive(Default)]
pub(crate) struct FakeManager {
    pub(crate) calls: RefCell<Vec<(String, Vec<String>)>>,
    pub(crate) missing: bool,
    pub(crate) linger: bool,
    pub(crate) old_artifact: bool,
    pub(crate) service_v1: bool,
    pub(crate) service_graphless: bool,
    pub(crate) fragment: Option<PathBuf>,
}
impl Manager for FakeManager {
    fn run(&self, program: &str, args: &[String]) -> Result<String> {
        self.calls
            .borrow_mut()
            .push((program.into(), args.to_vec()));
        if self.missing {
            return Err(ServiceError::Manager);
        }
        if program.ends_with("bigbud-remote-agent") {
            return Ok(if self.old_artifact {
                "inspect-local=1"
            } else if self.service_v1 {
                "inspect-local=1\tbackend-service=1"
            } else if self.service_graphless {
                "inspect-local=1\tbackend-service=2"
            } else {
                "inspect-local=1\tbackend-service=2\tbackend-service-graph=1"
            }
            .into());
        }
        if program.ends_with("loginctl") {
            return Ok(if self.linger { "yes\n" } else { "no\n" }.into());
        }
        if args.iter().any(|arg| arg == "--property=FragmentPath") {
            return self
                .fragment
                .as_ref()
                .map(|path| format!("FragmentPath={}\n", path.display()))
                .ok_or(ServiceError::Manager);
        }
        Ok("Version=252\n".into())
    }
}
