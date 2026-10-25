use super::super::child::Exit;
use super::*;

#[test]
fn kill_errors_wait_errors_and_expired_cleanup_deadlines_retain_owned_capacity() {
    let mut reservation = Reservation::reserve().unwrap();
    let id = reservation.id;
    let child = Arc::new(Child::new(123456));
    reservation.retain(Arc::clone(&child)).unwrap();
    // Keep this private slot inactive so concurrent production sweeps cannot
    // issue native calls on the injected numeric identity.
    for wait in [
        Ok(None),
        Err(io::Error::other("injected wait failure")),
        Ok(None),
    ] {
        poll_one(id, wait, || {
            Err(io::Error::other("injected kill/deadline failure"))
        });
        assert!(PENDING.lock().unwrap().contains_key(&id));
    }
    child
        .poll_with(|_| {
            Ok(Some(Exit {
                code: Some(0),
                signal: None,
            }))
        })
        .unwrap();
    poll_one(id, child.poll(), || panic!("verified reap must not signal"));
    assert!(!PENDING.lock().unwrap().contains_key(&id));
    reservation.transfer();
}
