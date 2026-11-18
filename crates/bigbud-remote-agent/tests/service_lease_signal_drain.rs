//! A supervisor signal drain must settle a detached original gateway lease even when the service
//! manager signals the whole control group (systemd `KillMode=control-group`): the monitor and the
//! original child receive the same SIGTERM as the supervisor.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
#[path = "support/recovery.fixture.rs"]
mod fixture;
use bigbud_remote_agent::service_lease::{Controller, State};
use fixture::{Fixture, wait_missing};
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
    writeln!(stdout, "\n{{\"event\":\"ready\",\"listen\":\"{address}\"}}").unwrap();
    stdout.flush().unwrap();
    let mut sink = Vec::new();
    let _eof = std::io::stdin().read_to_end(&mut sink);
    drop(listener);
}

fn parent(pid: u32) -> u32 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    stat.rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}
fn terminate(pid: u32) {
    // SAFETY: plain kill(2) of a live child this test owns; no memory is shared.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }, 0);
}
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|stat| {
            !stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z'))
        })
        .unwrap_or(false)
}

#[test]
fn control_group_sigterm_settles_a_detached_gateway_lease_with_exit_evidence() {
    let f = Fixture::new("signal-drain");
    let mut owner = f.owner();
    let binding = f.binding("signal-drain-gateway");
    let controller = Controller::current().unwrap();
    let upstream = f.listen();
    let grant = owner
        .start(binding.clone(), controller.clone(), &[7; 32], f.launch())
        .unwrap();
    assert_eq!(grant.snapshot.state, State::Spawned);
    let child = grant.snapshot.original_child_pid;
    let monitor = parent(child);
    assert_ne!(
        monitor,
        std::process::id(),
        "the monitor owns the original group"
    );
    // The backend handed the gateway to a successor before the supervisor was stopped.
    owner.detach(grant.generation()).unwrap();
    drop(upstream);

    // The service manager's stop signals every process of the unit at once.
    terminate(monitor);
    terminate(child);
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(child) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    // The original child keeps the default disposition and ends; its owner monitor survives.
    assert!(
        !alive(child),
        "the original child keeps the default SIGTERM disposition"
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        alive(monitor),
        "only the owner channel may end the lease monitor"
    );

    let exited = owner
        .revoke(&binding, &[7; 32], &controller, grant.generation())
        .expect("the drained lease settles with confirmed exit evidence");
    assert_eq!(exited.state, State::Exited);
    assert_eq!(exited.original_child_pid, child);
    wait_missing(child);
    wait_missing(monitor);
}
