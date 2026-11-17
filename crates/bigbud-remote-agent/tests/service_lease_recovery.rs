//! Durable readiness receipt and successor socket recovery against real Linux processes.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
#[path = "support/recovery.fixture.rs"]
mod fixture;
use bigbud_remote_agent::service_lease::{Controller, Error, State};
use fixture::{Fixture, inode, kill, kill_pid, old_controller, wait_missing};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// Not a test of its own: the original child launched by the monitor runs this body.
#[test]
fn gateway_stand_in_helper() {
    if std::env::var_os(fixture::HELPER_ENV).is_none() {
        return;
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut stdout = std::io::stdout();
    // libtest already wrote "test <name> ... " without a newline; end that line first.
    writeln!(stdout, "\n{{\"event\":\"ready\",\"listen\":\"{address}\"}}").unwrap();
    stdout.flush().unwrap();
    // Serve until the monitor closes the stdin lifeline.
    let mut sink = Vec::new();
    let _eof = std::io::stdin().read_to_end(&mut sink);
    drop(listener);
}

#[test]
fn successor_clears_exact_stale_socket_attaches_and_revokes() {
    let f = Fixture::new("attach");
    let (mut old, old_identity) = old_controller();
    let mut owner = f.owner();
    let binding = f.binding("recovery-attach");
    let original = f.listen();
    let grant = owner
        .start(binding.clone(), old_identity.clone(), &[7; 32], f.launch())
        .unwrap();
    assert_eq!(grant.snapshot.state, State::Spawned);
    let receipt = f.receipt().expect("readiness writes a durable receipt");
    assert_eq!(receipt["revision"], 1);
    assert_eq!(receipt["binding"]["nonce"], "recovery-attach");
    assert_eq!(receipt["child"]["pid"], grant.snapshot.original_child_pid);
    assert_eq!(receipt["controller"]["pid"], old_identity.pid);
    assert_eq!(receipt["upstream"]["socket"]["ino"], inode(&f.socket()));
    assert_ne!(receipt["listener"]["inode"], "0");

    let current = Controller::current().unwrap();
    assert!(
        matches!(
            owner.resume(&binding, &[7; 32], current.clone()),
            Err(Error::Refused)
        ),
        "a live original controller cannot be taken over"
    );
    drop(original); // Controller crash: its listener dies, the pathname remains.
    kill(&mut old);
    assert!(f.socket().exists());

    let resumed = owner.resume(&binding, &[7; 32], current.clone()).unwrap();
    assert_eq!(resumed.snapshot.state, State::Attaching);
    assert_eq!(
        resumed.snapshot.original_child_pid,
        grant.snapshot.original_child_pid
    );
    assert!(
        !f.socket().exists(),
        "exact refused stale inode was unlinked"
    );
    assert!(owner.with_bootstrap(resumed.generation(), |_| ()).is_ok());
    let receipt = f.receipt().unwrap();
    assert_eq!(receipt["revision"], 2);
    assert_eq!(receipt["controller"]["pid"], current.pid);
    assert!(receipt["upstream"]["socket"].is_null());

    // Unready until the successor publishes; nothing is mutated meanwhile.
    let pending = owner.resume(&binding, &[7; 32], current.clone()).unwrap();
    assert_eq!(pending.snapshot.state, State::Attaching);
    assert_eq!(f.receipt().unwrap()["revision"], 2);

    let successor = f.listen();
    let attached = owner.resume(&binding, &[7; 32], current.clone()).unwrap();
    assert_eq!(attached.snapshot.state, State::Spawned);
    assert_eq!(attached.generation(), resumed.generation());
    let receipt = f.receipt().unwrap();
    assert_eq!(receipt["revision"], 3);
    assert_eq!(receipt["upstream"]["socket"]["ino"], inode(&f.socket()));

    let exited = owner
        .revoke(&binding, &[7; 32], &current, attached.generation())
        .unwrap();
    assert_eq!(exited.state, State::Exited);
    assert!(f.receipt().is_none(), "confirmed exit removes the receipt");
    assert!(
        f.socket().exists(),
        "the live controller's own socket is untouched"
    );
    drop(successor);
    wait_missing(grant.snapshot.original_child_pid);
}

#[test]
fn successor_preserves_live_replaced_or_linked_upstream_and_stays_uncertain() {
    let f = Fixture::new("preserve");
    let (mut old, old_identity) = old_controller();
    let mut owner = f.owner();
    let binding = f.binding("recovery-preserve");
    let leaked = f.listen();
    let grant = owner
        .start(binding.clone(), old_identity, &[7; 32], f.launch())
        .unwrap();
    kill(&mut old);
    let current = Controller::current().unwrap();
    let before = f.receipt().unwrap();

    // The recorded inode still accepts (e.g. a leaked descriptor): never unlink it.
    assert!(matches!(
        owner.resume(&binding, &[7; 32], current.clone()),
        Err(Error::Uncertain)
    ));
    assert!(f.socket().exists());
    drop(leaked);

    // Another inode now occupies the path: preserved even though it refuses.
    f.replace_with_unrecorded_socket();
    let replaced = inode(&f.socket());
    assert!(matches!(
        owner.resume(&binding, &[7; 32], current.clone()),
        Err(Error::Uncertain)
    ));
    assert_eq!(inode(&f.socket()), replaced);

    // A symlink is never followed or removed.
    std::fs::rename(f.socket(), f.root.join("target.sock")).unwrap();
    std::os::unix::fs::symlink(f.root.join("target.sock"), f.socket()).unwrap();
    assert!(matches!(
        owner.resume(&binding, &[7; 32], current.clone()),
        Err(Error::Uncertain)
    ));
    assert_eq!(
        f.receipt().unwrap(),
        before,
        "uncertain recovery never mutates"
    );
    assert_eq!(owner.status().unwrap().state, State::Spawned);

    // Teardown by the successor still confirms the original child exit.
    let exited = owner.stop_original(&binding, &[7; 32], &current).unwrap();
    assert_eq!(exited.state, State::Exited);
    assert!(std::fs::symlink_metadata(f.socket()).unwrap().is_symlink());
    assert!(f.receipt().is_none());
    wait_missing(grant.snapshot.original_child_pid);
}

#[test]
fn gone_gateway_clears_exact_stale_socket_and_permits_fresh_start() {
    let f = Fixture::new("gone");
    let (mut old, old_identity) = old_controller();
    let mut owner = f.owner();
    let binding = f.binding("recovery-gone");
    let original = f.listen();
    let grant = owner
        .start(binding.clone(), old_identity, &[7; 32], f.launch())
        .unwrap();
    drop(original);
    kill(&mut old);
    kill_pid(grant.snapshot.original_child_pid);
    let deadline = Instant::now() + Duration::from_secs(5);
    while owner.status().unwrap().state != State::Exited && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(owner.status().unwrap().state, State::Exited);
    let current = Controller::current().unwrap();
    assert!(
        owner.resume(&binding, &[7; 32], current.clone()).is_err(),
        "a gone original child is never attached"
    );
    assert!(f.socket().exists());

    let exited = owner.stop_original(&binding, &[7; 32], &current).unwrap();
    assert_eq!(exited.state, State::Exited);
    assert!(
        !f.socket().exists(),
        "exact refused stale inode was unlinked"
    );
    assert!(f.receipt().is_none());

    let fresh_binding = f.binding("recovery-gone-fresh");
    let listener = f.listen();
    let fresh = owner
        .start(fresh_binding.clone(), current.clone(), &[8; 32], f.launch())
        .unwrap();
    assert_eq!(fresh.snapshot.state, State::Spawned);
    assert_eq!(
        f.receipt().unwrap()["binding"]["nonce"],
        "recovery-gone-fresh"
    );
    owner
        .revoke(&fresh_binding, &[8; 32], &current, fresh.generation())
        .unwrap();
    drop(listener);
    wait_missing(fresh.snapshot.original_child_pid);
}

#[test]
fn readiness_without_a_sealed_upstream_socket_is_never_reported_ready() {
    let f = Fixture::new("unsealed");
    let mut owner = f.owner();
    let binding = f.binding("recovery-unsealed");
    let current = Controller::current().unwrap();
    // No socket was published at the recorded upstream path.
    assert!(matches!(
        owner.start(binding.clone(), current.clone(), &[7; 32], f.launch()),
        Err(Error::Uncertain)
    ));
    assert_eq!(owner.status().unwrap().state, State::Uncertain);
    assert!(f.receipt().is_none());
    let exited = owner.stop_original(&binding, &[7; 32], &current).unwrap();
    assert_eq!(exited.state, State::Exited);
    wait_missing(exited.original_child_pid);
}
