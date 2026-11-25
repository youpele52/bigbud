use super::super::{SSH, tests::Fixture};
use super::*;
use std::{
    io::Read,
    os::unix::net::UnixStream,
    process::{Command, Stdio},
    time::Duration,
};

#[test]
fn actual_open_ssh_options_disable_all_other_authentication_methods() {
    // -G prints effective options and does not connect or run a helper.
    let mut command = Command::new(SSH);
    command
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .args(["-G", "-F", "/dev/null", "-T"]);
    for option in AUTH_OPTIONS {
        command.args(["-o", option]);
    }
    let output = command
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "PreferredAuthentications=publickey",
            "-o",
            "PasswordAuthentication=no",
            "--",
            "127.0.0.1",
        ])
        .output()
        .expect("stock ssh -G");
    assert!(output.status.success());
    let output = std::str::from_utf8(&output.stdout).expect("C locale options");
    for setting in [
        "batchmode no",
        "preferredauthentications password",
        "passwordauthentication yes",
        "numberofpasswordprompts 1",
        "identityagent none",
        "kbdinteractiveauthentication no",
        "gssapiauthentication no",
        "hostbasedauthentication no",
    ] {
        assert!(output.lines().any(|line| line == setting), "{setting}");
    }
    // 10.x reports this tristate option as true/false; older clients use yes/no.
    assert!(output.lines().any(|line| matches!(
        line,
        "pubkeyauthentication no" | "pubkeyauthentication false"
    )));
}

#[test]
fn undisposable_target_and_bad_password_never_create_a_master_and_wipe_input() {
    let fixture = Fixture::new();
    let mut slot = PosixMasterSlot::default();
    let generation = [0; 32];
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut bad = *b"invalid\nsynthetic";
    assert_eq!(
        slot.unlock_password(&fixture.transport, generation, &mut bad, deadline),
        Err(ErrorCode::OperationDenied)
    );
    assert!(bad.iter().all(|&byte| byte == 0));
    let mut password = *b"synthetic-fixture";
    assert_eq!(
        slot.unlock_password(&fixture.transport, generation, &mut password, deadline),
        Err(ErrorCode::ConfigUnsupported)
    );
    assert!(password.iter().all(|&byte| byte == 0));
    assert!(matches!(
        slot.list_unlocked_folders(&fixture.transport, generation, None, deadline),
        Err(ErrorCode::AuthRequired)
    ));
    assert!(slot.master.is_none());
}

#[test]
fn private_endpoint_rejects_another_process_lineage_and_cannot_be_reused() {
    let paths = PrivatePaths::new().expect("private directory");
    let path = paths.askpass_path().expect("askpass path");
    let mut listener = askpass::Listener::new(&paths).expect("askpass listener");
    // Same executable and uid, but its kernel parent is not the tracked SSH child.
    let _foreign = UnixStream::connect(&path).expect("unverified connect");
    assert!(listener.accept(std::process::id()).unwrap().is_none());
    listener.close(&paths).expect("close owned endpoint");
    assert!(UnixStream::connect(&path).is_err());
    assert!(listener.accept(std::process::id()).unwrap().is_none());
    paths.remove(None).expect("cleanup private directory");
}

#[test]
fn release_wipes_input_after_delivery_and_on_deadline() {
    let (tx, mut rx) = UnixStream::pair().expect("isolated socket pair");
    tx.set_nonblocking(true).unwrap();
    let mut password = *b"synthetic";
    askpass::release(
        tx,
        Secret(&mut password),
        Instant::now() + Duration::from_secs(1),
    )
    .expect("one framed delivery");
    assert!(password.iter().all(|&byte| byte == 0));
    let mut packet = Vec::new();
    rx.read_to_end(&mut packet)
        .expect("bounded delivery and EOF");
    assert!(packet == b"\0\x09synthetic");
    let (tx, _) = UnixStream::pair().expect("isolated socket pair");
    let mut password = *b"synthetic";
    assert_eq!(
        askpass::release(tx, Secret(&mut password), Instant::now()),
        Err(LOST)
    );
    assert!(password.iter().all(|&byte| byte == 0));
}
