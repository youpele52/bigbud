use super::InputOutcome;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

pub(super) const ENTRY_COST: usize = 256;
pub(super) const MAX_PROFILE_BYTES: usize = 8 * 1024 * 1024;
pub(super) const RETENTION: Duration = Duration::from_secs(600);
pub(super) static LEDGER_BYTES: AtomicUsize = AtomicUsize::new(0);
pub(super) static INPUT_BYTES: AtomicUsize = AtomicUsize::new(0);
static LEDGERS: Mutex<Vec<Weak<Shared>>> = Mutex::new(Vec::new());

pub(super) struct Record {
    pub digest: [u8; 32],
    pub outcome: InputOutcome,
    pub completed: Option<Instant>,
}
impl Drop for Record {
    fn drop(&mut self) {
        LEDGER_BYTES.fetch_sub(ENTRY_COST, Ordering::AcqRel);
    }
}
pub(super) struct Ledger {
    pub records: BTreeMap<u64, Record>,
    pub high_water: u64,
    pub expired_through: u64,
    pub fenced: bool,
    pub pending: usize,
    pub bytes: usize,
}
pub(super) struct Shared {
    pub ledger: Mutex<Ledger>,
    pub changed: Condvar,
    pub cancelled: AtomicBool,
    pub finished: AtomicBool,
}

pub(super) fn register(shared: &Arc<Shared>) -> std::io::Result<()> {
    let mut ledgers = LEDGERS
        .lock()
        .map_err(|_| std::io::Error::other("input registry poisoned"))?;
    ledgers.retain(|ledger| ledger.strong_count() > 0);
    if ledgers.len() >= 64 {
        return Err(std::io::Error::other("input writer profile limit"));
    }
    ledgers.push(Arc::downgrade(shared));
    Ok(())
}

/// Bounded profile sweep, outside any individual admission permit. Idle live
/// PTYs release expired charges without losing their per-generation replay floor.
pub(super) fn reclaim_expired(now: Instant) {
    let snapshot = match LEDGERS.lock() {
        Ok(ledgers) => ledgers.clone(),
        Err(_) => return,
    };
    for ledger in snapshot {
        if let Some(shared) = ledger.upgrade()
            && let Ok(mut ledger) = shared.ledger.try_lock()
        {
            prune(&mut ledger, now);
        }
    }
}

pub(super) fn reserve(counter: &AtomicUsize, bytes: usize) -> bool {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
            used.checked_add(bytes)
                .filter(|next| *next <= MAX_PROFILE_BYTES)
        })
        .is_ok()
}

fn expire_first(ledger: &mut Ledger) {
    if let Some((sequence, _)) = ledger.records.pop_first() {
        ledger.expired_through = sequence;
    }
}
pub(super) fn prune(ledger: &mut Ledger, now: Instant) {
    while ledger.records.first_key_value().is_some_and(|(_, record)| {
        record
            .completed
            .is_some_and(|at| now.saturating_duration_since(at) >= RETENTION)
    }) {
        expire_first(ledger);
    }
}

/// Retention TTL is an upper bound, not permission to stop healthy input.
/// Pressure may expire only the oldest settled contiguous prefix; never pending
/// or uncertain entries. The floor forbids reexecution after this early expiry.
pub(super) fn compact_completed(ledger: &mut Ledger) {
    while ledger.records.len() >= 4096
        && ledger.records.first_key_value().is_some_and(|(_, record)| {
            matches!(
                record.outcome,
                InputOutcome::Written(_) | InputOutcome::FailedBeforeWrite
            )
        })
    {
        expire_first(ledger);
    }
}
