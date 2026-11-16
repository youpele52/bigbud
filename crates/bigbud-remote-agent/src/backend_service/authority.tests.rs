#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::tests::fixture::{Fixture, mode, write};
use crate::backend_service::{Prerequisites, ServiceRole, cli::apply, tests::fixture::FakeManager};
use std::fs;
use std::os::unix::fs::MetadataExt;

fn marker(fixture: &Fixture) -> std::path::PathBuf {
    fixture
        .config
        .home
        .join(".bigbud/agent/account-authority-v1")
}
fn repin(fixture: &mut Fixture, text: &str) {
    write(&marker(fixture), text.as_bytes(), 0o600);
    fixture.config.authority_reservation_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
}
fn both_refuse(fixture: &Fixture) {
    for role in [ServiceRole::Backend, ServiceRole::Rust] {
        assert!(fixture.config.validate_role(role).is_err());
    }
    assert!(!fixture.config.rust_state.join("epoch").exists());
}
#[test]
fn shared_typescript_golden_root_identity_and_reservation_bytes() {
    let authority = "a".repeat(32);
    let installation = format!("sha256:{}", "c".repeat(64));
    let fingerprint = root_fingerprint(
        "/home/test/.bigbud/agent",
        1000,
        2049,
        42,
        &authority,
        &installation,
    );
    assert_eq!(
        fingerprint,
        "sha256:a8c81dbbd62f73822a5026e0ebfe6c2d9ec76a6f7960595d7209829deb8f789d"
    );
    let text = format!(
        "version=1\nauthority={authority}\ninstallation={installation}\nagent_root={fingerprint}\nbackend_home=/srv/bigbud\nbackend_home_dev=2049\nbackend_home_ino=40\nbackend_state=/srv/bigbud/state\nbackend_state_dev=2049\nbackend_state_ino=41\n"
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(text.as_bytes())),
        "436bbb6236cd5bee994ffedd2d2cb3ab75d42603cfbe481c4b526615b045d5fd"
    );
    assert_eq!(
        field(&decode(&text).unwrap(), "backend_state").unwrap(),
        "/srv/bigbud/state"
    );
    assert!(decode(&(text.clone() + "version=1\n")).is_err());
    assert!(decode(&text.replace('\n', "\r\n")).is_err());
}
#[test]
fn explicit_reservation_is_required_before_both_roles_and_is_never_created_by_validation() {
    let fixture = Fixture::new();
    fs::remove_file(marker(&fixture)).unwrap();
    both_refuse(&fixture);
    assert!(!marker(&fixture).exists());
}
#[test]
fn changed_pin_authority_and_installation_are_refused_without_regeneration() {
    let mut fixture = Fixture::new();
    let original = fs::read_to_string(marker(&fixture)).unwrap();
    write(
        &marker(&fixture),
        format!("{original}unknown=value\n").as_bytes(),
        0o600,
    );
    both_refuse(&fixture);
    let foreign = original.replace(
        &format!("authority={}", fixture.config.authority),
        &format!("authority={}", "b".repeat(32)),
    );
    repin(&mut fixture, &foreign);
    both_refuse(&fixture);
    repin(&mut fixture, &original);
    fixture.config.expected_installation_fingerprint = format!("sha256:{}", "d".repeat(64));
    both_refuse(&fixture);
    assert_eq!(fs::read_to_string(marker(&fixture)).unwrap(), original);
}
#[test]
fn backend_state_or_base_replacement_cannot_reuse_the_reservation() {
    for state_only in [true, false] {
        let fixture = Fixture::new();
        let path = if state_only {
            fixture.config.backend_home.join("state")
        } else {
            fixture.config.backend_home.clone()
        };
        fs::rename(&path, path.with_extension("previous")).unwrap();
        fs::create_dir_all(fixture.config.backend_home.join("state")).unwrap();
        mode(&fixture.config.backend_home, 0o700);
        mode(&fixture.config.backend_home.join("state"), 0o700);
        both_refuse(&fixture);
    }
}
#[test]
fn copied_agent_root_is_not_re_adopted_even_when_reservation_bytes_match() {
    let fixture = Fixture::new();
    let agent = fixture.config.home.join(".bigbud/agent");
    let bytes = fs::read(marker(&fixture)).unwrap();
    fs::rename(&agent, agent.with_extension("previous")).unwrap();
    fs::create_dir(&agent).unwrap();
    mode(&agent, 0o700);
    write(&marker(&fixture), &bytes, 0o600);
    assert!(verify(&fixture.config).is_err());
    assert_eq!(fs::read(marker(&fixture)).unwrap(), bytes);
}
#[test]
fn readonly_linked_and_malformed_reservations_are_preserved() {
    for kind in ["readonly", "symlink", "hardlink", "duplicate"] {
        let mut fixture = Fixture::new();
        let path = marker(&fixture);
        let original = fs::read_to_string(&path).unwrap();
        match kind {
            "readonly" => mode(&path, 0o400),
            "symlink" => {
                fs::rename(&path, path.with_extension("saved")).unwrap();
                std::os::unix::fs::symlink(path.with_extension("saved"), &path).unwrap();
            }
            "hardlink" => fs::hard_link(&path, path.with_extension("alias")).unwrap(),
            _ => repin(&mut fixture, &(original.clone() + "version=1\n")),
        }
        both_refuse(&fixture);
        if kind != "duplicate" {
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }
}
#[test]
fn backend_state_must_remain_under_the_configured_canonical_base() {
    let mut fixture = Fixture::new();
    let original = fs::read_to_string(marker(&fixture)).unwrap();
    let home = fs::metadata(&fixture.config.home).unwrap();
    let changed = original
        .lines()
        .map(|line| {
            if line.starts_with("backend_state=") {
                format!("backend_state={}", fixture.config.home.display())
            } else if line.starts_with("backend_state_dev=") {
                format!("backend_state_dev={}", home.dev())
            } else if line.starts_with("backend_state_ino=") {
                format!("backend_state_ino={}", home.ino())
            } else {
                line.into()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    repin(&mut fixture, &changed);
    both_refuse(&fixture);
}
#[test]
fn historical_service_v1_is_refused_before_staging_or_new_service_flags() {
    let fixture = Fixture::new();
    let manager = FakeManager {
        service_v1: true,
        ..FakeManager::default()
    };
    assert!(
        apply(
            &fixture.config,
            "stage",
            true,
            &manager,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(!fixture.root.join(".config").exists());
    assert!(
        manager
            .calls
            .borrow()
            .iter()
            .all(|(_, args)| args == &["--check", "--capabilities"])
    );
}

#[test]
fn noncanonical_backend_alias_is_not_an_alternate_service_binding() {
    let mut fixture = Fixture::new();
    fixture.config.backend_home = fixture.config.backend_home.join(".");
    both_refuse(&fixture);
}

#[test]
fn state_projection_reuses_full_pinned_reservation_and_never_infers_userdata() {
    let fixture = Fixture::new();
    let original = fs::read(marker(&fixture)).unwrap();
    assert_eq!(
        reserved_backend_state(&fixture.config).unwrap(),
        fixture.config.backend_home.join("state")
    );
    let state = fixture.config.backend_home.join("state");
    fs::rename(&state, state.with_extension("original")).unwrap();
    fs::create_dir(&state).unwrap();
    mode(&state, 0o700);
    assert!(reserved_backend_state(&fixture.config).is_err());
    assert_eq!(fs::read(marker(&fixture)).unwrap(), original);
}
