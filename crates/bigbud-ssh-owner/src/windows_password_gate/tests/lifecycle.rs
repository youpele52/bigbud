use std::sync::mpsc::{Receiver, TryRecvError, channel};

use super::*;

const USER: Activity = Activity::User(UserAction::Browse);
const PASSWORD: ReleaseRole = ReleaseRole::DestinationPassword;
const ACCEPTED: ProbeOutcome = ProbeOutcome::AuthenticatedProbeCompleted;
const OTHER_CHILD: ProbeBinding<'static> = ProbeBinding {
    child: VerifiedChild::from_verified_identity(43),
    ..BINDING
};
const NEXT_CHILD: ProbeBinding<'static> = ProbeBinding {
    target: NEXT_GENERATION,
    child: VerifiedChild::from_verified_identity(44),
};
const SYNTHETIC: [u8; 4] = [17, 0, 109, 255];
const IDLE: Duration = Duration::from_secs(600);

struct Wipe {
    address: usize,
    observed: Receiver<bool>,
}

impl Wipe {
    fn still_retained(&self) {
        assert_eq!(self.observed.try_recv(), Err(TryRecvError::Empty));
    }

    fn wiped(&self) {
        assert_eq!(self.observed.try_recv(), Ok(true));
        assert_eq!(self.observed.try_recv(), Err(TryRecvError::Disconnected));
    }

    fn assert_same_allocation(&self, bytes: &[u8]) {
        assert_eq!(bytes.as_ptr() as usize, self.address);
        assert_eq!(bytes, SYNTHETIC);
    }
}

fn observed_password() -> (PasswordBytes, Wipe) {
    let bytes = Box::<[u8]>::from(SYNTHETIC);
    let address = bytes.as_ptr() as usize;
    let (tx, observed) = channel();
    let mut password = PasswordBytes::from_boxed_slice(bytes);
    password.observe_wipe(move |bytes| {
        // Observe the same live allocation after volatile stores and before
        // deallocation. No dangling-pointer reads or allocator assumptions.
        // The test may already have failed and dropped its receiver.
        let _ = tx.send(bytes.as_ptr() as usize == address && bytes == [0; SYNTHETIC.len()]);
    });
    (password, Wipe { address, observed })
}

fn just_before(deadline: Duration) -> Duration {
    deadline.checked_sub(Duration::from_millis(1)).unwrap()
}

fn pending() -> (PasswordLifecycle<'static>, Wipe) {
    let mut store = PasswordLifecycle::new(TARGET, START);
    let (password, wipe) = observed_password();
    assert!(store.begin_user_unlock(TARGET, BINDING, QUALIFIED, password, START));
    (store, wipe)
}

fn delivered(store: &mut PasswordLifecycle<'_>, wipe: &Wipe, now: Duration) {
    assert!(
        store.release_probe_password(TARGET, BINDING, PASSWORD, now, |bytes, budget| {
            wipe.assert_same_allocation(bytes);
            assert_eq!(budget, DEADLINE.checked_sub(now).unwrap());
            ReleaseObservation::DeliveredAt(now)
        })
    );
}

fn ready() -> (PasswordLifecycle<'static>, Wipe) {
    let (mut store, wipe) = pending();
    delivered(&mut store, &wipe, RELEASE);
    assert!(store.cached_bytes().is_none());
    wipe.still_retained();
    assert!(store.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
    wipe.assert_same_allocation(store.cached_bytes().unwrap());
    (store, wipe)
}

#[test]
fn cache_is_same_allocation_and_background_never_refreshes_it() {
    let (mut store, wipe) = ready();
    let cutoff = START + IDLE;
    assert!(!store.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
    store.evict_child(TARGET, BINDING, COMPLETE);
    for now in [COMPLETE, just_before(cutoff)] {
        assert_eq!(
            store.access(TARGET, Activity::Monitor, now),
            Access::CacheEligible
        );
        for background in [Activity::Cleanup, Activity::Askpass] {
            assert_eq!(
                store.access(TARGET, background, now),
                Access::NoCredentialAccess
            );
        }
        wipe.still_retained();
    }
    store.expire(TARGET, cutoff);
    wipe.wiped();
    assert!(store.cached_bytes().is_none());
    assert_eq!(
        store.access(TARGET, Activity::Monitor, cutoff),
        Access::Paused
    );
    assert_eq!(store.access(TARGET, USER, cutoff), Access::UnlockRequired);
}

#[test]
fn qualifying_user_actions_refresh_before_but_not_at_idle_boundary() {
    for action in [
        UserAction::TerminalInput,
        UserAction::TerminalOpen,
        UserAction::Browse,
        UserAction::Read,
        UserAction::Turn,
        UserAction::TransferStart,
        UserAction::Connect,
        UserAction::Unlock,
    ] {
        let (mut store, wipe) = ready();
        let user = Activity::User(action);
        let last_moment = just_before(START + IDLE);
        assert_eq!(
            store.access(TARGET, user, last_moment),
            Access::CacheEligible
        );
        assert_eq!(
            store.access(TARGET, Activity::Monitor, START + IDLE),
            Access::CacheEligible
        );
        wipe.still_retained();
        assert_eq!(
            store.access(TARGET, user, last_moment + IDLE),
            Access::UnlockRequired
        );
        wipe.wiped();
    }
}

#[test]
fn no_prompt_and_nonpositive_outcomes_wipe_instead_of_caching() {
    let (mut no_prompt, wipe) = pending();
    assert!(!no_prompt.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
    assert!(no_prompt.cached_bytes().is_none());
    wipe.wiped();
    for outcome in [
        ProbeOutcome::PasswordRejected,
        ProbeOutcome::PartialAuthentication,
        ProbeOutcome::TransportLost,
        ProbeOutcome::Unverified,
    ] {
        let (mut store, wipe) = pending();
        delivered(&mut store, &wipe, RELEASE);
        assert!(!store.complete(TARGET, BINDING, outcome, COMPLETE));
        assert!(store.cached_bytes().is_none());
        wipe.wiped();
    }
}

#[test]
fn foreign_or_wrong_role_and_duplicate_claims_receive_no_bytes() {
    let (mut store, wipe) = pending();
    for (child, role) in [(OTHER_CHILD, PASSWORD), (BINDING, ReleaseRole::Other)] {
        assert!(
            !store.release_probe_password(TARGET, child, role, RELEASE, |_, _| {
                panic!("foreign request borrowed pending bytes")
            })
        );
    }
    delivered(&mut store, &wipe, RELEASE);
    assert!(
        !store.release_probe_password(TARGET, BINDING, PASSWORD, RELEASE, |_, _| {
            panic!("duplicate request borrowed pending bytes")
        })
    );
    assert!(!store.complete(TARGET, OTHER_CHILD, ACCEPTED, COMPLETE));
    assert!(store.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
    wipe.assert_same_allocation(store.cached_bytes().unwrap());
    drop(store);
    wipe.wiped();
}

#[test]
fn cancellation_wipes_before_or_after_delivery_but_foreign_eviction_does_not() {
    for release in [false, true] {
        let (mut store, wipe) = pending();
        if release {
            delivered(&mut store, &wipe, RELEASE);
        }
        store.evict_child(TARGET, OTHER_CHILD, RELEASE);
        wipe.still_retained();
        store.evict_child(TARGET, BINDING, COMPLETE);
        wipe.wiped();
        assert!(!store.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
        assert_eq!(store.access(TARGET, USER, COMPLETE), Access::UnlockRequired);
    }
}

#[test]
fn failed_or_out_of_budget_delivery_wipes_and_cannot_be_completed() {
    for observation in [
        ReleaseObservation::FailedOrUncertain,
        ReleaseObservation::DeliveredAt(DEADLINE),
        ReleaseObservation::DeliveredAt(START),
    ] {
        let (mut store, wipe) = pending();
        assert!(
            !store.release_probe_password(TARGET, BINDING, PASSWORD, RELEASE, |bytes, _| {
                wipe.assert_same_allocation(bytes);
                observation
            })
        );
        wipe.wiped();
        assert!(!store.complete(TARGET, BINDING, ACCEPTED, DEADLINE));
    }
}

#[test]
fn user_activity_cannot_extend_pending_deadline_or_replace_pending_bytes() {
    let (mut store, pending_wipe) = pending();
    let (password, rejected_wipe) = observed_password();
    assert!(!store.begin_user_unlock(TARGET, OTHER_CHILD, QUALIFIED, password, RELEASE));
    rejected_wipe.wiped();
    assert_eq!(
        store.access(TARGET, USER, just_before(DEADLINE)),
        Access::UnlockInProgress
    );
    pending_wipe.still_retained();
    store.expire(TARGET, DEADLINE);
    pending_wipe.wiped();
    assert!(
        !store.release_probe_password(TARGET, BINDING, PASSWORD, DEADLINE, |_, _| {
            panic!("expired prompt borrowed pending bytes")
        })
    );
}

#[test]
fn completion_at_probe_deadline_wipes_a_released_password() {
    let (mut store, wipe) = pending();
    delivered(&mut store, &wipe, just_before(DEADLINE));
    assert!(!store.complete(TARGET, BINDING, ACCEPTED, DEADLINE));
    wipe.wiped();
    let (password, retry_wipe) = observed_password();
    assert!(store.begin_user_unlock(TARGET, OTHER_CHILD, QUALIFIED, password, DEADLINE));
    assert!(!store.complete(TARGET, BINDING, ACCEPTED, DEADLINE));
    retry_wipe.still_retained();
    store.revoke();
    retry_wipe.wiped();
}

#[test]
fn authoritative_generation_change_wipes_and_old_receipts_cannot_touch_successor() {
    let (mut old, old_wipe) = pending();
    delivered(&mut old, &old_wipe, RELEASE);
    assert!(!old.complete(NEXT_GENERATION, BINDING, ACCEPTED, COMPLETE));
    old_wipe.wiped();
    assert_eq!(old.access(TARGET, USER, COMPLETE), Access::Revoked);

    let mut next = PasswordLifecycle::new(NEXT_GENERATION, COMPLETE);
    let (password, next_wipe) = observed_password();
    assert!(next.begin_user_unlock(NEXT_GENERATION, NEXT_CHILD, QUALIFIED, password, COMPLETE));
    assert!(next.release_probe_password(
        NEXT_GENERATION,
        NEXT_CHILD,
        PASSWORD,
        COMPLETE,
        |bytes, _| {
            next_wipe.assert_same_allocation(bytes);
            ReleaseObservation::DeliveredAt(COMPLETE)
        }
    ));
    assert!(!next.complete(NEXT_GENERATION, BINDING, ACCEPTED, COMPLETE));
    next_wipe.still_retained();
    assert!(next.complete(NEXT_GENERATION, NEXT_CHILD, ACCEPTED, COMPLETE));
    assert_eq!(next.access(TARGET, USER, COMPLETE), Access::Revoked);
    next_wipe.wiped();
}

#[test]
fn unqualified_probe_discards_submitted_buffer_without_creating_pending_state() {
    let mut store = PasswordLifecycle::new(TARGET, START);
    let (password, wipe) = observed_password();
    let with_fallback = ProbeQualification {
        password_only_without_fallback: false,
        ..QUALIFIED
    };
    assert!(!store.begin_user_unlock(TARGET, BINDING, with_fallback, password, START));
    wipe.wiped();
    assert_eq!(store.access(TARGET, USER, START), Access::UnlockRequired);
}

#[test]
fn disconnect_clock_regression_and_owner_drop_wipe_retained_bytes() {
    for fixture in [pending, ready] {
        let (mut store, wipe) = fixture();
        store.revoke();
        wipe.wiped();
        assert_eq!(store.access(TARGET, USER, COMPLETE), Access::Revoked);

        let (mut store, wipe) = fixture();
        store.expire(TARGET, COMPLETE);
        assert_eq!(
            store.access(TARGET, Activity::Monitor, START),
            Access::Revoked
        );
        wipe.wiped();

        let (store, wipe) = fixture();
        drop(store);
        wipe.wiped();
    }
}

#[test]
fn unwinding_delivery_cannot_leave_a_pending_allocation_or_authorize_cache() {
    let (mut store, wipe) = pending();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        store.release_probe_password(TARGET, BINDING, PASSWORD, RELEASE, |bytes, _| {
            wipe.assert_same_allocation(bytes);
            panic!("synthetic delivery panic")
        })
    }));
    assert!(result.is_err());
    wipe.wiped();
    assert!(!store.complete(TARGET, BINDING, ACCEPTED, COMPLETE));
}
