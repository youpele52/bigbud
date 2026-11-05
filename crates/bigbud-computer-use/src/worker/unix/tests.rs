#![allow(clippy::unwrap_used)]
use super::*;
use std::num::NonZeroU32;

#[test]
fn creation_identity_is_stable_for_current_process() {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    let first = inspect(pid).unwrap();
    assert_eq!(first, inspect(pid).unwrap());
    assert!(crate::guard::record::valid_id(&first.creation));
    assert_eq!(first.pid, pid);
}

#[test]
fn invalid_signed_pid_is_refused_before_os_call() {
    assert!(inspect(NonZeroU32::new(u32::MAX).unwrap()).is_err());
}

fn stat(start: &str) -> String {
    format!(
        "42 (odd ) name\n) S 10 42 {} {start} 0",
        vec!["0"; 16].join(" ")
    )
}
const BOOT: &str = "12345678-1234-1234-1234-123456789abc";
#[test]
fn linux_identity_uses_start_ticks_and_boot_not_comm_or_pid_alone() {
    let pid = NonZeroU32::new(42).unwrap();
    let first = identity_linux::parse(pid, BOOT, &stat("123")).unwrap();
    assert_eq!(first.parent, 10);
    assert_eq!(first.group, 42);
    assert_eq!(first.creation, format!("linux:{BOOT}:123"));
    assert_ne!(
        first,
        identity_linux::parse(pid, BOOT, &stat("124")).unwrap()
    );
    assert_ne!(
        first,
        identity_linux::parse(pid, "aaaaaaaa-1234-1234-1234-123456789abc", &stat("123")).unwrap()
    );
}
#[test]
fn linux_identity_refuses_corrupt_or_unbounded_data() {
    let pid = NonZeroU32::new(42).unwrap();
    for input in [
        stat("0"),
        stat("bad"),
        stat("18446744073709551616"),
        "42 (x) S 10 42".into(),
        "x".repeat(4097),
        stat("123").replacen("42", "43", 1),
    ] {
        assert!(identity_linux::parse(pid, BOOT, &input).is_err());
    }
    assert!(identity_linux::parse(pid, "a".repeat(36).as_str(), &stat("123")).is_err());
}
#[test]
fn containment_refuses_nonleader_foreign_parent_and_invalid_identity() {
    let identity = ProcessIdentity {
        pid: NonZeroU32::new(42).unwrap(),
        parent: 10,
        group: 42,
        creation: "birth-1".into(),
    };
    assert!(anchor::validate_anchor(&identity, 10).is_ok());
    assert!(anchor::validate_anchor(&identity, 11).is_err());
    assert!(
        anchor::validate_anchor(
            &ProcessIdentity {
                group: 41,
                ..identity.clone()
            },
            10
        )
        .is_err()
    );
    assert!(
        anchor::validate_anchor(
            &ProcessIdentity {
                creation: "".into(),
                ..identity
            },
            10
        )
        .is_err()
    );
}
