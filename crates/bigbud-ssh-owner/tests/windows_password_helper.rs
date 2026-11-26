//! Executable-level Windows test with a synthetic SSH parent, not inbox
//! OpenSSH qualification. Never supply a real credential here.

#[cfg(windows)]
#[path = "windows_password_helper/fixture.rs"]
mod fixture;

use std::process::Command;

const HELPER: &str = env!("CARGO_BIN_EXE_bigbud-ssh-password-helper");

#[test]
fn metadata_does_not_advertise_qualified_password_support() {
    let output = Command::new(HELPER).arg("--metadata").output().unwrap();
    assert!(output.stderr.is_empty());
    if cfg!(windows) {
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            concat!(
                "{\"binary\":\"bigbud-ssh-password-helper\",\"version\":\"",
                env!("CARGO_PKG_VERSION"),
                "\",\"helperProtocol\":1,\"windowsPasswordSupported\":false}\n",
            ),
        );
    } else {
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn standalone_refuses_an_untrusted_invocation_without_output() {
    for args in [vec![], vec!["prompt"], vec!["--metadata", "extra"]] {
        let output = Command::new(HELPER)
            .env_clear()
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}
