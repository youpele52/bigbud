use super::*;
use std::{
    fs::{self, DirBuilder},
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const LABEL: &str = "[proof-host]:2222";
const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "bigbud-extended-trust-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, record: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, record).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn scans_all_sources_and_never_hides_revocation_or_ca_behind_a_pin() {
    let fixture = Fixture::new();
    let first = fixture.write("first", &format!("[other]:2222 {OTHER}\n"));
    let second = fixture.write(
        "second",
        &format!("[PROOF-*]:2222,![other]:2222 {KEY} comment\n"),
    );
    let global = fixture.write("global", &format!("{LABEL} {KEY}\n"));
    let paths = [&*first, &*second, &*global];
    let result = read(&paths, LABEL, deadline()).unwrap();
    assert_eq!(result.pin.unwrap().record, format!("{LABEL} {KEY}\n"));
    for (entry, want) in [
        (format!("@revoked {LABEL} {KEY}\n"), CHANGED),
        (
            format!("@cert-authority {LABEL} {KEY}\n"),
            ErrorCode::ConfigUnsupported,
        ),
        (format!("{LABEL} {OTHER}\n"), CHANGED),
    ] {
        fs::write(&global, entry).unwrap();
        assert!(matches!(read(&paths, LABEL, deadline()), Err(error) if error == want));
    }
    fs::write(&global, format!("@revoked [elsewhere]:2222 {KEY}\n")).unwrap();
    assert!(read(&paths, LABEL, deadline()).unwrap().pin.is_some());
}

#[test]
fn approved_first_use_only_appends_first_path_and_fences_source_changes() {
    let fixture = Fixture::new();
    let comment = "# existing comment without newline";
    let first = fixture.write("first", comment);
    let second = fixture.write("second", "");
    let global = fixture.write("global", "# intentional global trust\n");
    let paths = [&*first, &*second, &*global];
    let raw = format!("{LABEL} {KEY}\n");
    let key = HostKey::from_record(raw.as_bytes(), LABEL).unwrap();
    let inspection = read(&paths, LABEL, deadline()).unwrap();
    assert!(inspection.pin.is_none());
    assert_eq!(
        approve(
            &global,
            &paths,
            LABEL,
            &key,
            inspection.stamp,
            false,
            deadline()
        ),
        Err(READ_ONLY),
    );
    fs::write(&second, "# policy changed\n").unwrap();
    assert_eq!(
        approve(
            &first,
            &paths,
            LABEL,
            &key,
            inspection.stamp,
            false,
            deadline()
        ),
        Err(CHANGED)
    );
    assert_eq!(fs::read_to_string(&first).unwrap(), comment);
    let fresh = read(&paths, LABEL, deadline()).unwrap();
    assert!(approve(&first, &paths, LABEL, &key, fresh.stamp, false, deadline()).is_ok());
    assert_eq!(
        fs::read_to_string(&first).unwrap(),
        format!("{comment}\n{raw}")
    );
    assert_eq!(fs::read_to_string(&second).unwrap(), "# policy changed\n");
    assert_eq!(
        fs::read_to_string(&global).unwrap(),
        "# intentional global trust\n"
    );
}

#[test]
fn certificate_authority_selection_is_exact_and_refuses_ambiguous_records() {
    let fixture = Fixture::new();
    let alias = "ca-alias";
    let record = format!("@cert-authority {alias} {KEY}\n");
    let first = fixture.write("one", &record);
    let second = fixture.write("two", &record);
    let paths = [first.as_path(), second.as_path()];
    let lookup = || read_certificate_authority(&paths, alias, deadline());
    assert_eq!(lookup().unwrap().unwrap().record, record);
    assert!(matches!(
        read(&paths, alias, deadline()),
        Err(ErrorCode::ConfigUnsupported)
    ));
    for (row, code) in [
        (format!("@cert-authority {alias} {OTHER}\n"), CHANGED),
        (format!("@revoked {alias} {KEY}\n"), CHANGED),
        (
            format!("@cert-authority ca-* {KEY}\n"),
            ErrorCode::ConfigUnsupported,
        ),
        (format!("{alias} {KEY}\n"), ErrorCode::ConfigUnsupported),
    ] {
        fs::write(&second, row).unwrap();
        assert!(matches!(lookup(), Err(error) if error == code));
    }
}

#[test]
fn supports_bounded_ascii_patterns_with_negation_and_literal_port_brackets() {
    assert_eq!(
        pattern_list("![proof-host]:2222,[proof-*]:2222", LABEL),
        Ok(false)
    );
    assert_eq!(pattern_list("[PROOF-?OST]:2222", LABEL), Ok(true));
    assert_eq!(pattern_list("[proof-host]:22", LABEL), Ok(false));
    assert_eq!(
        pattern_list("!a,*,,", LABEL),
        Err(ErrorCode::ConfigUnsupported)
    );
}
