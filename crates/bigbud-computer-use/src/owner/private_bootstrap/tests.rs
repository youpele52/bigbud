#![allow(clippy::unwrap_used)]
use super::{
    BootstrapPermit,
    exchange::{ParentExchange, child_read},
    io::write_all,
};
use crate::{
    Role,
    guard::{PriorityRetirement, RetirementCause},
    owner::{IndependentLifeline, WatcherOutcome, unix_peer::ensure_private_fd},
    worker::{ExecutionRoot, unix::inspect},
};
use std::{
    io::{self, Read},
    num::NonZeroU32,
    os::{fd::AsRawFd, unix::net::UnixStream},
    thread,
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn root() -> ExecutionRoot {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    ExecutionRoot {
        pid,
        creation_identity: inspect(pid).unwrap().creation,
        generation: "private-worker-1".into(),
    }
}
fn closed(mut socket: UnixStream) {
    socket.set_nonblocking(true).unwrap();
    match socket.read(&mut [0]) {
        Ok(0) => {}
        Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
        result => panic!("endpoint not closed: {result:?}"),
    }
}

#[test]
fn production_permit_refuses_without_filesystem_or_launch_effects() {
    assert_eq!(
        BootstrapPermit::verify().err().unwrap().kind(),
        io::ErrorKind::Unsupported
    );
}

#[test]
fn inherited_credential_composes_with_existing_auth_and_watcher() {
    let end = deadline();
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    assert!(parent.courier.local_addr().unwrap().is_unnamed());
    assert!(courier.local_addr().unwrap().is_unnamed());
    ensure_private_fd(&parent.courier).unwrap();
    ensure_private_fd(&courier).unwrap();
    let expected = root();
    let mut cap = parent.deliver(expected.clone(), Role::Worker).unwrap();
    let credential = child_read(courier, end).unwrap();
    // Test-only same-process socket, NOT evidence of a child's post-exec PID.
    let (child, receiver) = UnixStream::pair().unwrap();
    let child = credential.send(child).unwrap();
    let peer = cap.authenticate_stream(receiver).unwrap();
    assert_eq!(peer.execution_root(), &expected);
    ensure_private_fd(&child).unwrap();
    ensure_private_fd(&peer.stream).unwrap();
    let requests = PriorityRetirement::default();
    let watcher = IndependentLifeline::start(peer, requests.clone()).unwrap();
    drop(child);
    let end = deadline();
    let mut causes = 0;
    while causes == 0 && Instant::now() < end {
        causes = requests.take_causes();
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(causes, RetirementCause::WorkerLost as u8);
    assert_eq!(
        watcher.stop_and_join(Duration::from_secs(1)).ok(),
        Some(WatcherOutcome::ParentLost)
    );
}

#[test]
fn correct_delivery_cannot_substitute_wrong_pid_or_creation() {
    for change_pid in [false, true] {
        let end = deadline();
        let (parent, courier) = ParentExchange::pair(end).unwrap();
        let mut expected = root();
        if change_pid {
            expected.pid = NonZeroU32::new(expected.pid.get() + 1).unwrap();
        } else {
            expected.creation_identity.push_str("-stale");
        }
        let mut cap = parent.deliver(expected, Role::Worker).unwrap();
        let credential = child_read(courier, end).unwrap();
        let (sender, receiver) = UnixStream::pair().unwrap();
        let sender = credential.send(sender).unwrap();
        assert!(cap.authenticate_stream(receiver).is_err());
        closed(sender);
    }
}

#[test]
fn separate_issuances_cannot_swap_secrets_and_failure_burns_receiver() {
    let end = deadline();
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    let mut cap = parent.deliver(root(), Role::Worker).unwrap();
    let correct = child_read(courier, end).unwrap();
    let (other, courier) = ParentExchange::pair(end).unwrap();
    let mut other_root = root();
    other_root.generation = "private-worker-2".into();
    let _other_cap = other.deliver(other_root, Role::Worker).unwrap();
    let wrong = child_read(courier, end).unwrap();
    let (sender, receiver) = UnixStream::pair().unwrap();
    let sender = wrong.send(sender).unwrap();
    assert!(cap.authenticate_stream(receiver).is_err());
    closed(sender);
    let (sender, receiver) = UnixStream::pair().unwrap();
    let sender = correct.send(sender).unwrap();
    assert!(cap.authenticate_stream(receiver).is_err());
    closed(sender);
}

#[test]
fn delivery_and_auth_use_original_deadline_not_a_renewed_budget() {
    let (parent, child) = ParentExchange::pair(deadline()).unwrap();
    let parent = ParentExchange {
        deadline: Instant::now(),
        ..parent
    };
    assert!(parent.deliver(root(), Role::Worker).is_err());
    closed(child);

    let end = Instant::now() + Duration::from_millis(25);
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    let mut cap = parent.deliver(root(), Role::Worker).unwrap();
    let credential = child_read(courier, deadline()).unwrap();
    thread::sleep(end.saturating_duration_since(Instant::now()));
    let (sender, receiver) = UnixStream::pair().unwrap();
    let sender = credential.send(sender).unwrap();
    assert!(cap.authenticate_stream(receiver).is_err());
    closed(sender);
}

#[test]
fn child_deadline_expires_before_send_and_closes_owned_endpoint() {
    let end = Instant::now() + Duration::from_millis(25);
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    let _cap = parent.deliver(root(), Role::Worker).unwrap();
    let credential = child_read(courier, end).unwrap();
    thread::sleep(end.saturating_duration_since(Instant::now()));
    let (sender, witness) = UnixStream::pair().unwrap();
    assert_eq!(
        credential.send(sender).err().unwrap().kind(),
        io::ErrorKind::TimedOut
    );
    closed(witness);
}

#[test]
fn child_rejects_truncated_or_extra_delivery_and_closes_courier() {
    for size in [0, 1, 37, 39] {
        let end = deadline();
        let (parent, courier) = ParentExchange::pair(end).unwrap();
        let mut bytes = vec![0; size];
        if size >= 38 {
            bytes[..4].copy_from_slice(&34_u32.to_be_bytes());
            bytes[4] = 1;
            bytes[5] = 3;
        }
        write_all(&parent.courier, &bytes, end).unwrap();
        parent.courier.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(child_read(courier, end).is_err());
        closed(parent.courier);
    }
}

#[test]
fn extra_writer_copy_cannot_hide_lifetime_or_renew_child_deadline() {
    let end = Instant::now() + Duration::from_millis(25);
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    let leaked_writer = parent.courier.try_clone().unwrap();
    let _cap = parent.deliver(root(), Role::Worker).unwrap();
    assert_eq!(
        child_read(courier, end).err().unwrap().kind(),
        io::ErrorKind::TimedOut
    );
    closed(leaked_writer);
}

#[test]
fn cancelled_or_failed_delivery_closes_unused_couriers() {
    let (parent, child) = ParentExchange::pair(deadline()).unwrap();
    drop(parent);
    assert!(child_read(child, deadline()).is_err());
    let (parent, child) = ParentExchange::pair(deadline()).unwrap();
    drop(child);
    assert!(parent.deliver(root(), Role::Worker).is_err());
}

#[test]
fn noncloexec_child_endpoint_refuses_without_repair() {
    let end = deadline();
    let (parent, courier) = ParentExchange::pair(end).unwrap();
    let _cap = parent.deliver(root(), Role::Worker).unwrap();
    let credential = child_read(courier, end).unwrap();
    let (sender, witness) = UnixStream::pair().unwrap();
    // SAFETY: test owns the live fd; no process launches in these fixtures.
    assert_eq!(
        unsafe { libc::fcntl(sender.as_raw_fd(), libc::F_SETFD, 0) },
        0
    );
    assert!(credential.send(sender).is_err());
    closed(witness);
}

#[test]
fn writer_backpressure_and_closed_peer_are_bounded_without_sigpipe() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let size: libc::c_int = 1024;
    // SAFETY: live test socket and readable exactly-sized integer option.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                sender.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of_val(&size) as libc::socklen_t,
            )
        },
        0
    );
    // A regressed blocking send must fail this test, not hang the test process.
    // This test-only holder closes the peer after one second if the writer did
    // not finish; the assertion distinguishes that escape from the real budget.
    let (finished, completion) = std::sync::mpsc::channel();
    let holder = thread::spawn(move || {
        let on_time = completion.recv_timeout(Duration::from_secs(1)).is_ok();
        drop(receiver);
        on_time
    });
    let bytes = [0; 64 * 1024];
    let result = write_all(&sender, &bytes, Instant::now() + Duration::from_millis(25));
    let notified = finished.send(()).is_ok();
    let completed_without_escape = holder.join().unwrap();
    assert!(
        notified && completed_without_escape,
        "send relied on test-only peer closure"
    );
    assert_eq!(result.err().unwrap().kind(), io::ErrorKind::TimedOut);
    assert!(write_all(&sender, &[0], deadline()).is_err());
}
