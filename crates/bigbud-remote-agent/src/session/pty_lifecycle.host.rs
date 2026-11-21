//! Host-wide terminal lifecycle state (plan §7.1, §8.7, §8.3, §14): the pushed policy, the
//! 64-entry notice ring, the event sink to connected owners, the spool store, lost spools from
//! a previous host, and owner presence for the orphan timer. One per supervisor; stdio agents
//! have none and keep refusing lifecycle requests.

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use bigbud_protocol::v1;

use crate::terminal_policy::{
    Clock, HostPolicy, PolicyEngine, PolicyState, PolicyUpdate, ProcessProbe, SystemClock,
};
use crate::terminal_spool::{SpoolLimits, SpoolStore};

#[path = "pty_lifecycle.policy_wire.rs"]
mod policy_wire;
pub(crate) use policy_wire::{policy_from_wire, policy_to_wire};

/// Delivers one unsolicited lifecycle frame (83, 84, 93) to every connected owner. It must not
/// block: the supervisor uses each connection's bounded streaming window.
pub(crate) type EventSink = Arc<dyn Fn(&v1::Frame) + Send + Sync>;

pub(crate) const NOTICE_RING: usize = 64;

pub(crate) mod kind {
    pub const IDLE_WARNING: &str = "idle_warning";
    pub const IDLE_WARNING_CLEARED: &str = "idle_warning_cleared";
    pub const IDLE_CLOSED: &str = "idle_closed";
    pub const PRESSURE_CLOSED: &str = "pressure_closed";
    pub const PRESSURE_NO_CANDIDATE: &str = "pressure_no_candidate";
    pub const LIMIT_CLOSED: &str = "limit_closed";
    pub const ORPHAN_CLOSED: &str = "orphan_closed";
    pub const QUIT_CLOSED: &str = "quit_closed";
    pub const MODEL_INVALID: &str = "model_invalid";
    pub const SPOOL_DEGRADED: &str = "spool_degraded";
}

/// What `--supervisor` was started with, plus test seams.
pub(crate) struct HostOptions {
    pub local_desktop_host: bool,
    pub spool_limits: SpoolLimits,
    pub clock: Arc<dyn Clock>,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            local_desktop_host: false,
            spool_limits: SpoolLimits::default(),
            clock: Arc::new(SystemClock),
        }
    }
}

pub(crate) struct PolicySlot {
    pub(crate) state: PolicyState,
    /// `HostPolicy.memory_pressure_enabled` from the latest push.
    pub(crate) pressure_enabled: bool,
}

struct NoticeRing {
    next_id: u64,
    entries: VecDeque<v1::PtyLifecycleNotice>,
}

pub(crate) struct HostLifecycle {
    epoch: String,
    clock: Arc<dyn Clock>,
    local_desktop_host: bool,
    policy: Mutex<PolicySlot>,
    pub(crate) engine: Mutex<PolicyEngine>,
    notices: Mutex<NoticeRing>,
    sink: RwLock<Option<EventSink>>,
    spool: Option<SpoolStore>,
    /// `pty_id -> lost_at_ms` for spools a previous host left behind (inventory `lost`).
    lost: Mutex<BTreeMap<String, u64>>,
    owners: AtomicUsize,
    /// When the last owner disconnected (the orphan timer); `None` while one is connected.
    orphaned_since: Mutex<Option<u64>>,
    /// Bytes held by in-flight snapshot copies (counted in `screen_model_bytes`).
    pub(crate) copy_bytes: AtomicUsize,
    pub(crate) probe: ProcessProbe,
    /// The last live snapshots, reused while their screen is unchanged (R7).
    pub(crate) snapshot_cache: Mutex<super::pty_screen_cache::SnapshotCache>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Every guarded value here is plain bookkeeping that stays consistent across a panic.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl HostLifecycle {
    /// Opens the spool under `state_root` (when given) and sweeps what a previous host left.
    /// A spool that cannot open only disables `terminal.spool`; the host still runs.
    pub(crate) fn new(epoch: &str, state_root: Option<&Path>, options: HostOptions) -> Arc<Self> {
        let now = options.clock.now_ms();
        let spool = state_root.and_then(|root| {
            SpoolStore::open(root, options.spool_limits)
                .map_err(|error| eprintln!("terminal spool unavailable: {}", error.code()))
                .ok()
        });
        let mut lost = BTreeMap::new();
        if let Some(store) = &spool {
            match store.sweep(now) {
                Ok(report) => {
                    for spool in report.lost {
                        lost.insert(spool.pty_id, spool.lost_at_ms);
                    }
                }
                Err(error) => eprintln!("terminal spool sweep failed: {}", error.code()),
            }
        }
        Arc::new(Self {
            epoch: epoch.to_owned(),
            clock: options.clock,
            local_desktop_host: options.local_desktop_host,
            policy: Mutex::new(PolicySlot {
                state: PolicyState::default(),
                pressure_enabled: false,
            }),
            engine: Mutex::new(PolicyEngine::default()),
            notices: Mutex::new(NoticeRing {
                next_id: 1,
                entries: VecDeque::with_capacity(NOTICE_RING),
            }),
            sink: RwLock::new(None),
            spool,
            lost: Mutex::new(lost),
            owners: AtomicUsize::new(0),
            orphaned_since: Mutex::new(Some(now)),
            copy_bytes: AtomicUsize::new(0),
            probe: ProcessProbe::new(),
            snapshot_cache: Mutex::new(super::pty_screen_cache::SnapshotCache::default()),
        })
    }

    pub(crate) fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    pub(crate) fn local_desktop_host(&self) -> bool {
        self.local_desktop_host
    }

    pub(crate) fn spool(&self) -> Option<&SpoolStore> {
        self.spool.as_ref()
    }

    pub(crate) fn set_sink(&self, sink: EventSink) {
        *self.sink.write().unwrap_or_else(PoisonError::into_inner) = Some(sink);
    }

    pub(crate) fn broadcast(&self, frame: &v1::Frame) {
        let sink = self
            .sink
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(sink) = sink {
            sink(frame);
        }
    }

    /// Records a notice in the ring (replayed after reconnects) and pushes it to owners.
    pub(crate) fn notice(&self, pty_id: &str, kind: &str, closes_at_ms: u64) {
        let notice = {
            let mut ring = lock(&self.notices);
            let notice = v1::PtyLifecycleNotice {
                notice_id: ring.next_id,
                pty_id: pty_id.to_owned(),
                kind: kind.to_owned(),
                closes_at_ms,
                occurred_at_ms: self.now_ms(),
            };
            ring.next_id = ring.next_id.saturating_add(1);
            if ring.entries.len() == NOTICE_RING {
                ring.entries.pop_front();
            }
            ring.entries.push_back(notice.clone());
            notice
        };
        self.broadcast(&v1::Frame {
            payload: Some(v1::frame::Payload::PtyLifecycleNotice(notice)),
        });
    }

    pub(crate) fn replay_notices(
        &self,
        request: v1::HostNoticeReplayRequest,
    ) -> v1::HostNoticeReplayResponse {
        let mut response = v1::HostNoticeReplayResponse {
            request_id: request.request_id,
            agent_epoch: self.epoch.clone(),
            ..Default::default()
        };
        if !request.expected_epoch.is_empty() && request.expected_epoch != self.epoch {
            response.error_code = "PTY_EPOCH_MISMATCH".to_owned();
            return response;
        }
        let ring = lock(&self.notices);
        let oldest = ring.entries.front().map_or(ring.next_id, |n| n.notice_id);
        response.accepted = true;
        response.gap = request.after_notice_id.saturating_add(1) < oldest
            && request.after_notice_id.saturating_add(1) < ring.next_id;
        response.notices = ring
            .entries
            .iter()
            .filter(|notice| notice.notice_id > request.after_notice_id)
            .cloned()
            .collect();
        response
    }

    pub(crate) fn policy(&self) -> HostPolicy {
        lock(&self.policy).state.current().clone()
    }

    pub(crate) fn pressure_enabled(&self) -> bool {
        let slot = lock(&self.policy);
        slot.pressure_enabled && slot.state.current().lifecycle_enabled
    }

    /// Applies a push (the latest revision wins) and returns the effective clamped values.
    pub(crate) fn apply_policy(&self, wire: Option<&v1::HostPolicy>) -> v1::HostPolicy {
        let mut slot = lock(&self.policy);
        let (policy, pressure) = policy_from_wire(wire);
        match slot.state.apply(policy) {
            PolicyUpdate::Applied(effective) => {
                slot.pressure_enabled = pressure;
                policy_to_wire(&effective, pressure)
            }
            PolicyUpdate::Stale(current) => policy_to_wire(&current, slot.pressure_enabled),
        }
    }

    pub(crate) fn owner_connected(&self) {
        self.owners.fetch_add(1, Ordering::AcqRel);
        *lock(&self.orphaned_since) = None;
    }

    pub(crate) fn owner_disconnected(&self) {
        let previous = self
            .owners
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            })
            .unwrap_or(0);
        if previous <= 1 {
            *lock(&self.orphaned_since) = Some(self.now_ms());
        }
    }

    pub(crate) fn owners(&self) -> usize {
        self.owners.load(Ordering::Acquire)
    }

    pub(crate) fn orphaned_since(&self) -> Option<u64> {
        *lock(&self.orphaned_since)
    }

    pub(crate) fn lost_ptys(&self) -> BTreeMap<String, u64> {
        lock(&self.lost).clone()
    }

    pub(crate) fn is_lost(&self, pty_id: &str) -> bool {
        lock(&self.lost).contains_key(pty_id)
    }

    /// A new PTY reusing a lost id replaces the old spool.
    pub(crate) fn forget_lost(&self, pty_id: &str) {
        lock(&self.lost).remove(pty_id);
    }
}
