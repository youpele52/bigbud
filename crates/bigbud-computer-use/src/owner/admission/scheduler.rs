//! One physical lane. FIFO within a caller, round-robin across callers; an
//! admitted compound sequence holds the lane until `finish` (never split for
//! fairness). Expired/cancelled/revoked queued work is removed as not-started
//! and can never execute later. Public waits never occupy the lane. Every
//! removed-before-start ticket must be settled `NotStarted` in the ledger by
//! the coordinator so its pending entry never occupies outcome capacity.
use super::limits::{MAX_QUEUED_OPERATIONS, MAX_QUEUED_PER_CALLER, MAX_QUEUED_REQUEST_BYTES};
use std::collections::{BTreeMap, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub ticket: u64,
    pub caller: String,
    pub bytes: usize,
    pub deadline_ns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueRefusal {
    QueueFull,
    CallerQueueFull,
    BytesExceeded,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cancelled {
    /// Removed before starting: outcome not_started, never executes.
    NotStarted,
    /// Holding the lane: retirement required, effect unknown until settled.
    InFlight,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Dispatch {
    pub started: Option<Queued>,
    /// Deadline passed while queued: not_started, removed for good.
    pub expired: Vec<u64>,
}

#[derive(Default)]
pub struct Scheduler {
    queues: BTreeMap<String, VecDeque<Queued>>,
    rotation: VecDeque<String>,
    total: usize,
    bytes: usize,
    active: Option<Queued>,
}

impl Scheduler {
    pub fn enqueue(&mut self, operation: Queued) -> Result<(), QueueRefusal> {
        if self.contains(operation.ticket) {
            return Err(QueueRefusal::Duplicate);
        }
        if self.total >= MAX_QUEUED_OPERATIONS {
            return Err(QueueRefusal::QueueFull);
        }
        let queue = self.queues.get(&operation.caller);
        if queue.is_some_and(|queue| queue.len() >= MAX_QUEUED_PER_CALLER) {
            return Err(QueueRefusal::CallerQueueFull);
        }
        let bytes = self.bytes.checked_add(operation.bytes);
        if bytes.is_none_or(|bytes| bytes > MAX_QUEUED_REQUEST_BYTES) {
            return Err(QueueRefusal::BytesExceeded);
        }
        if queue.is_none_or(VecDeque::is_empty) {
            self.rotation.push_back(operation.caller.clone());
        }
        self.bytes += operation.bytes;
        self.total += 1;
        self.queues
            .entry(operation.caller.clone())
            .or_default()
            .push_back(operation);
        Ok(())
    }

    fn contains(&self, ticket: u64) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.ticket == ticket)
            || self
                .queues
                .values()
                .flatten()
                .any(|queued| queued.ticket == ticket)
    }

    /// Starts the next fair operation only when the lane is free.
    pub fn start_next(&mut self, now_ns: u64) -> Dispatch {
        let mut dispatch = Dispatch::default();
        let expired: Vec<u64> = self
            .queues
            .values()
            .flatten()
            .filter(|queued| queued.deadline_ns <= now_ns)
            .map(|queued| queued.ticket)
            .collect();
        for ticket in expired {
            self.remove_queued(ticket);
            dispatch.expired.push(ticket);
        }
        if self.active.is_some() {
            return dispatch;
        }
        while let Some(caller) = self.rotation.pop_front() {
            let Some(queue) = self.queues.get_mut(&caller) else {
                continue;
            };
            let Some(next) = queue.pop_front() else {
                continue;
            };
            if queue.is_empty() {
                self.queues.remove(&caller);
            } else {
                self.rotation.push_back(caller);
            }
            self.debit(next.bytes);
            self.active = Some(next.clone());
            dispatch.started = Some(next);
            break;
        }
        dispatch
    }

    /// Releases the lane only for the active ticket (after settlement or
    /// required retirement of the whole compound sequence).
    pub fn finish(&mut self, ticket: u64) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.ticket == ticket)
        {
            self.active = None;
            return true;
        }
        false
    }

    pub fn cancel(&mut self, ticket: u64) -> Option<Cancelled> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.ticket == ticket)
        {
            return Some(Cancelled::InFlight);
        }
        self.remove_queued(ticket).then_some(Cancelled::NotStarted)
    }

    /// Caller revocation (cancel, mode/provider change): every queued ticket
    /// is removed not-started; an in-flight one is reported for retirement.
    pub fn revoke_caller(&mut self, caller: &str) -> (Vec<u64>, Option<u64>) {
        let removed: Vec<u64> = self
            .queues
            .remove(caller)
            .map(|queue| {
                queue
                    .into_iter()
                    .map(|queued| {
                        self.debit(queued.bytes);
                        queued.ticket
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.rotation.retain(|entry| entry != caller);
        let in_flight = self
            .active
            .as_ref()
            .filter(|active| active.caller == caller)
            .map(|active| active.ticket);
        (removed, in_flight)
    }

    pub fn queued(&self) -> usize {
        self.total
    }

    /// Callers with queued work (empty queues are always removed).
    pub fn callers(&self) -> usize {
        self.queues.len()
    }

    /// Accounting invariant: every debit matches an earlier enqueue credit.
    fn debit(&mut self, bytes: usize) {
        debug_assert!(
            self.total > 0 && self.bytes >= bytes,
            "scheduler accounting"
        );
        self.total = self.total.saturating_sub(1);
        self.bytes = self.bytes.saturating_sub(bytes);
    }

    fn remove_queued(&mut self, ticket: u64) -> bool {
        let Some((caller, index)) = self.queues.iter().find_map(|(caller, queue)| {
            let index = queue.iter().position(|queued| queued.ticket == ticket)?;
            Some((caller.clone(), index))
        }) else {
            return false;
        };
        let Some(queue) = self.queues.get_mut(&caller) else {
            return false;
        };
        let removed = queue.remove(index);
        if queue.is_empty() {
            self.queues.remove(&caller);
            self.rotation.retain(|entry| *entry != caller);
        }
        if let Some(removed) = removed {
            self.debit(removed.bytes);
        }
        true
    }
}
