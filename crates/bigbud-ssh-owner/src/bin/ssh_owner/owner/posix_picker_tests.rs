use super::*;
#[cfg(target_os = "macos")]
use std::net::Ipv4Addr;

#[cfg(all(test, target_os = "macos"))]
#[test]
fn picker_attachment_scope_is_exact_root_and_key_only() {
    let root = Path::new("/private/tmp/bigbud-picker-sshd-fixturetest");
    let config = TransportConfig {
        ssh: "/usr/bin/ssh".into(),
        keyscan: "/usr/bin/ssh-keyscan".into(),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 22222,
        user: "picker".into(),
        identity: root.join("identity"),
        known_hosts: root.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
    };
    let socket = root.join("owner.sock");
    assert!(is_disposable_picker(
        &config,
        PosixPickerFixture::Key,
        Some(&socket)
    ));
    for mode in [
        PosixPickerFixture::CancellableRead,
        PosixPickerFixture::CancellableMuxRead,
    ] {
        assert!(!is_disposable_picker(&config, mode, Some(&socket)));
    }
    for wrong in [root.join("other.sock"), root.join("../owner.sock")] {
        assert!(!is_disposable_picker(
            &config,
            PosixPickerFixture::Key,
            Some(&wrong)
        ));
    }
}

#[cfg(test)]
#[test]
fn rebind_generation_keeps_trust_failure_paused_until_connect() {
    let old = [7; 32];
    let fresh = [8; 32];
    let mut picker = MasterPicker {
        generation: Some(old),
        verified: true,
        ..MasterPicker::default()
    };
    picker.record_observation(old, Some(ErrorCode::HostKeyChanged));
    picker.rebind_generation().unwrap();
    assert_eq!(picker.admit(fresh), Err(ErrorCode::HostKeyChanged));
    picker.transition_committed();
    assert_eq!(picker.admit(fresh), Ok(()));
}

#[cfg(test)]
#[test]
fn separate_picker_state_per_target_isolates_trust_and_generation() {
    let first_generation = [1; 32];
    let second_generation = [2; 32];
    let mut first = MasterPicker {
        generation: Some(first_generation),
        verified: true,
        ..MasterPicker::default()
    };
    let mut second = MasterPicker {
        generation: Some(second_generation),
        verified: true,
        ..MasterPicker::default()
    };
    // A trust loss observed on one target pauses only that target.
    first.record_observation(first_generation, Some(ErrorCode::HostKeyChanged));
    assert_eq!(
        first.admit(first_generation),
        Err(ErrorCode::HostKeyChanged)
    );
    assert_eq!(second.admit(second_generation), Ok(()));
    // A generation change on one target does not fence the other's lease.
    first.transition_committed();
    first.generation = Some([3; 32]);
    assert_eq!(first.admit([9; 32]), Err(ErrorCode::StaleGeneration));
    assert_eq!(second.admit(second_generation), Ok(()));
    // Retiring one target's generation leaves the other's state intact.
    assert_eq!(first.retire(), Ok(()));
    assert_eq!(second.retire(), Ok(()));
    assert_eq!(second.generation, Some(second_generation));
}

#[cfg(test)]
#[test]
fn retiring_a_failed_generation_does_not_authorize_a_replacement() {
    let token = [7; 32];
    let mut picker = MasterPicker {
        generation: Some(token),
        verified: true,
        trust_fault: Some(ErrorCode::HostKeyChanged),
        ..MasterPicker::default()
    };
    assert_eq!(picker.retire(), Ok(()));
    assert_eq!(picker.generation, Some(token));
    assert_eq!(picker.trust_fault, Some(ErrorCode::HostKeyChanged));
    picker.transition_committed();
    assert_eq!(picker.generation, None);
    assert_eq!(picker.trust_fault, None);
}
