use super::*;
use crate::transport::ListFailure;
use std::cell::Cell;

#[test]
fn cancellation_before_admission_leaves_the_idle_lease_and_stale_scope_untouched() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let saved = slot.master.as_mut().unwrap().live_pid().unwrap();
    let deadline = Instant::now() + READY_LIMIT;
    assert!(matches!(
        slot.open_and_list_folders_cancellable(&fixture.transport, STALE, None, deadline, || true),
        Err(ListFailure::Error(ErrorCode::StaleGeneration))
    ));
    assert!(matches!(
        slot.open_and_list_folders_cancellable(&fixture.transport, GEN, None, deadline, || true),
        Err(ListFailure::Cancelled)
    ));
    assert_eq!(slot.master.as_mut().unwrap().live_pid(), Ok(saved));
    slot.invalidate(GEN).expect("retire fixture lease");
}

#[test]
fn cancellation_after_admission_reaps_and_removes_only_the_owned_lease() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let socket = slot.master.as_ref().unwrap().paths.socket.clone();
    let observed = Cell::new(false);
    assert!(matches!(
        slot.open_and_list_folders_cancellable(
            &fixture.transport,
            GEN,
            None,
            Instant::now() + READY_LIMIT,
            || observed.replace(true)
        ),
        Err(ListFailure::Cancelled)
    ));
    assert!(slot.master.is_none());
    assert!(!socket.parent().unwrap().exists());
}

#[test]
fn cancellation_with_unowned_residual_socket_quarantines_the_lease() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let socket = slot.master.as_ref().unwrap().paths.socket.clone();
    let outside = UnixListener::bind(&socket).expect("bind outside peer");
    outside.set_nonblocking(true).expect("bound outside accept");
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).expect("fixture socket mode");
    let inode = fs::symlink_metadata(&socket).unwrap().ino();
    let observed = Cell::new(false);
    let deadline = Instant::now() + READY_LIMIT;
    assert!(matches!(
        slot.open_and_list_folders_cancellable(&fixture.transport, GEN, None, deadline, || {
            observed.replace(true)
        }),
        Err(ListFailure::CleanupUnconfirmed)
    ));
    assert_eq!(fs::symlink_metadata(&socket).unwrap().ino(), inode);
    let retained = slot
        .master
        .as_ref()
        .expect("failed cleanup retains the slot");
    assert!(retained.closing && retained.child.is_none());
    assert!(matches!(
        slot.open_and_list_folders_cancellable(&fixture.transport, GEN, None, deadline, || false),
        Err(ListFailure::Error(UNAVAILABLE))
    ));
    let (mut attempt, _) = outside.accept().expect("peer identity check connected");
    attempt.set_nonblocking(true).expect("bound outside read");
    assert_eq!(attempt.read(&mut [0]).expect("outside read sees EOF"), 0);
    fs::remove_file(socket).expect("remove outside socket our test created");
    slot.invalidate(GEN).expect("retire quarantined slot");
}

#[test]
fn hashed_pin_is_refused_before_allocating_or_launching_a_master() {
    let fixture = Fixture::new();
    let root = fixture.transport.config.identity.parent().unwrap();
    fs::write(
        &fixture.transport.config.known_hosts,
        "|1|synthetic-hash-marker\n",
    )
    .expect("replace pin");
    let mut slot = PosixMasterSlot::default();
    assert!(matches!(
        slot.open_and_list_folders_cancellable(
            &fixture.transport,
            GEN,
            None,
            Instant::now() + READY_LIMIT,
            || false
        ),
        Err(ListFailure::Error(ErrorCode::ConfigUnsupported))
    ));
    assert!(slot.master.is_none());
    PosixMasterSlot::require_no_residual_lease(root).expect("no lease directory reserved");
}
