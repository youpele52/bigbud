//! Replay protection separate from the bounded outcome cache.
//!
//! - Callers are owner-issued sessions (`<generation>.c<n>`) from a counter
//!   that is never reused, so retiring one may drop its high-water mark
//!   without reopening replay: an unknown or retired session always refuses.
//! - An operation ID ends in `.<caller_sequence>` (canonical decimal, > 0).
//!   The sequence IS the operation identity, so an operation whose outcome was
//!   evicted or expired is always at/below the high-water mark and refuses;
//!   eviction can never make it acceptable again.
//! - Owner restart (new generation) refuses every old ticket and request.
//! - Lookups are caller-scoped and content-free once egress policy changed.
use super::limits::{
    MAX_CALLER_SESSIONS, MAX_DETAIL_TEXT_BYTES, MAX_DIAGNOSTIC_TAIL_BYTES,
    MAX_OUTCOME_METADATA_BYTES, MAX_RETAINED_OUTCOMES, OUTCOME_RETENTION,
};
use crate::guard::record::valid_id;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    NotStarted,
    Completed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub completion: Completion,
    pub code: String,
    /// Egress policy revision the projection was authorized under.
    pub policy_revision: u64,
    pub projected: Vec<u8>,
    pub capture_error: Option<String>,
}
impl Outcome {
    fn bytes(&self) -> usize {
        self.code.len() + self.projected.len() + self.capture_error.as_ref().map_or(0, String::len)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Pending,
    Settled(Outcome),
    /// Retention/egress no longer allows content: settlement metadata only.
    ContentFree {
        completion: Completion,
        code: String,
    },
    /// Unknown or evicted: never permission to execute again.
    Expired,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    InvalidIdentity,
    GenerationMismatch,
    StaleSequence,
    ConflictingDigest,
    UnknownCaller,
    /// Retirement refused: the session still has pending (unsettled) work.
    CallerBusy,
    CallerCapacity,
    OutcomeCapacity,
    OutcomeTooLarge,
    UnknownTicket,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub ticket: String,
    pub number: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admit {
    New(Admitted),
    /// Same caller/operation/sequence/digest: deterministic, never re-executed.
    Duplicate(Lookup),
}

#[derive(Debug)]
struct Entry {
    digest: [u8; 32],
    ticket: u64,
    settled: Option<(Outcome, u64)>,
}

#[derive(Debug)]
struct Session {
    id: super::session::CallerSession,
    thread: String,
    high_water: u64,
}

type Key = (u64, String);

pub struct Ledger {
    generation: String,
    next_ticket: u64,
    next_caller: u64,
    sessions: BTreeMap<u64, Session>,
    entries: BTreeMap<Key, Entry>,
    tickets: BTreeMap<u64, Key>,
    metadata_bytes: usize,
}

impl Ledger {
    /// `owner_generation` MUST be unique per owner start (it embeds a
    /// CSPRNG component in production); reusing one would revive old caller
    /// sessions and tickets. Restart safety rests on this precondition.
    pub fn new(owner_generation: &str) -> Option<Self> {
        valid_id(owner_generation).then(|| Self {
            generation: owner_generation.into(),
            next_ticket: 1,
            next_caller: 1,
            sessions: BTreeMap::new(),
            entries: BTreeMap::new(),
            tickets: BTreeMap::new(),
            metadata_bytes: 0,
        })
    }

    /// Issues a fresh caller session for a trusted server thread identity.
    pub fn open_caller(&mut self, thread: &str) -> Result<String, Refusal> {
        if !valid_id(thread) {
            return Err(Refusal::InvalidIdentity);
        }
        if self.sessions.len() >= MAX_CALLER_SESSIONS {
            return Err(Refusal::CallerCapacity);
        }
        let number = self.next_caller;
        self.next_caller = number.checked_add(1).ok_or(Refusal::CallerCapacity)?;
        let id = format!("{}.c{number}", self.generation);
        let session = Session {
            id: super::session::CallerSession::issued(id.clone()),
            thread: thread.into(),
            high_water: 0,
        };
        self.sessions.insert(number, session);
        Ok(id)
    }

    /// Ends a session (end/cancel/provider replacement/idle reclaim). Refused
    /// while it has pending work; its settled outcomes are dropped with it.
    /// Returns the owned session so authority state is forgotten only after a
    /// successful retirement (`AuthorityTable::forget` consumes it).
    pub fn retire_caller(
        &mut self,
        caller: &str,
    ) -> Result<super::session::CallerSession, Refusal> {
        let number = self.caller_number(caller)?;
        let mut owned = Vec::new();
        let range = self.entries.range((number, String::new())..);
        for (key, entry) in range.take_while(|(key, _)| key.0 == number) {
            if entry.settled.is_none() {
                return Err(Refusal::CallerBusy);
            }
            owned.push(key.clone());
        }
        for key in owned {
            self.remove(&key);
        }
        self.sessions
            .remove(&number)
            .map(|session| session.id)
            .ok_or(Refusal::UnknownCaller)
    }

    /// Lends the live session for authority projection/revocation. A retired,
    /// forged or other-generation ID never yields one.
    pub fn session(&self, caller: &str) -> Option<&super::session::CallerSession> {
        let number = self.caller_number(caller).ok()?;
        self.sessions.get(&number).map(|session| &session.id)
    }

    pub fn caller_thread(&self, caller: &str) -> Option<&str> {
        let number = self.caller_number(caller).ok()?;
        self.sessions
            .get(&number)
            .map(|session| session.thread.as_str())
    }

    pub fn admit(
        &mut self,
        generation: &str,
        caller: &str,
        operation: &str,
        digest: [u8; 32],
        now_ns: u64,
    ) -> Result<Admit, Refusal> {
        if generation != self.generation {
            return Err(Refusal::GenerationMismatch);
        }
        let sequence = operation_sequence(operation).ok_or(Refusal::InvalidIdentity)?;
        let number = self.caller_number(caller)?;
        self.expire(now_ns);
        let key = (number, operation.to_string());
        if let Some(entry) = self.entries.get(&key) {
            // Same key implies the same sequence: a retry, never a re-execution.
            if entry.digest != digest {
                return Err(Refusal::ConflictingDigest);
            }
            return Ok(Admit::Duplicate(
                self.lookup(caller, operation, digest, None, now_ns),
            ));
        }
        let high = self
            .sessions
            .get(&number)
            .map_or(u64::MAX, |s| s.high_water);
        if sequence <= high {
            // Evicted, expired or never-retained older sequence: refuse.
            return Err(Refusal::StaleSequence);
        }
        if self.entries.len() >= MAX_RETAINED_OUTCOMES && !self.evict_one_settled() {
            return Err(Refusal::OutcomeCapacity);
        }
        let ticket = self.next_ticket;
        self.next_ticket = ticket.checked_add(1).ok_or(Refusal::OutcomeCapacity)?;
        let session = self
            .sessions
            .get_mut(&number)
            .ok_or(Refusal::UnknownCaller)?;
        session.high_water = sequence;
        self.tickets.insert(ticket, key.clone());
        let entry = Entry {
            digest,
            ticket,
            settled: None,
        };
        self.entries.insert(key, entry);
        Ok(Admit::New(Admitted {
            ticket: format!("{}.{ticket}", self.generation),
            number: ticket,
        }))
    }

    fn caller_number(&self, caller: &str) -> Result<u64, Refusal> {
        let number = caller
            .strip_prefix(&self.generation)
            .and_then(|rest| rest.strip_prefix(".c"))
            .and_then(canonical_number)
            .ok_or(Refusal::UnknownCaller)?;
        if !self.sessions.contains_key(&number) {
            return Err(Refusal::UnknownCaller);
        }
        Ok(number)
    }

    /// Resolves a wire ticket to its number only within this generation.
    pub fn ticket_number(&self, ticket: &str) -> Result<u64, Refusal> {
        let number = ticket
            .strip_prefix(&self.generation)
            .and_then(|rest| rest.strip_prefix('.'))
            .and_then(canonical_number)
            .filter(|number| self.tickets.contains_key(number))
            .ok_or(Refusal::UnknownTicket)?;
        Ok(number)
    }

    pub fn settle(&mut self, ticket: u64, outcome: Outcome, now_ns: u64) -> Result<(), Refusal> {
        if outcome.projected.len() > MAX_DETAIL_TEXT_BYTES
            || outcome
                .capture_error
                .as_ref()
                .is_some_and(|e| e.len() > MAX_DIAGNOSTIC_TAIL_BYTES)
            || !valid_id(&outcome.code)
        {
            return Err(Refusal::OutcomeTooLarge);
        }
        let key = self
            .tickets
            .get(&ticket)
            .ok_or(Refusal::UnknownTicket)?
            .clone();
        if self.entries.get(&key).is_none_or(|e| e.settled.is_some()) {
            return Err(Refusal::UnknownTicket);
        }
        // Make room BEFORE consuming the ticket: a capacity refusal leaves the
        // entry pending and still settleable. Pending entries are never evicted.
        let size = outcome.bytes();
        while self.metadata_bytes.saturating_add(size) > MAX_OUTCOME_METADATA_BYTES {
            if !self.evict_one_settled() {
                return Err(Refusal::OutcomeCapacity);
            }
        }
        let entry = self.entries.get_mut(&key).ok_or(Refusal::UnknownTicket)?;
        entry.settled = Some((outcome, now_ns));
        self.tickets.remove(&ticket);
        self.metadata_bytes = self.metadata_bytes.saturating_add(size);
        Ok(())
    }

    /// Caller-scoped; another caller's operation is indistinguishable from
    /// absent. `egress_revision` None = internal duplicate path (no payload).
    pub fn lookup(
        &self,
        caller: &str,
        operation: &str,
        digest: [u8; 32],
        egress_revision: Option<u64>,
        now_ns: u64,
    ) -> Lookup {
        let Some(entry) = self
            .caller_number(caller)
            .ok()
            .and_then(|number| self.entries.get(&(number, operation.into())))
        else {
            return Lookup::Expired;
        };
        if entry.digest != digest {
            return Lookup::Conflict;
        }
        match &entry.settled {
            None => Lookup::Pending,
            Some((_, at)) if expired(*at, now_ns) => Lookup::Expired,
            Some((outcome, _)) if egress_revision == Some(outcome.policy_revision) => {
                Lookup::Settled(outcome.clone())
            }
            Some((outcome, _)) => Lookup::ContentFree {
                completion: outcome.completion,
                code: outcome.code.clone(),
            },
        }
    }

    fn expire(&mut self, now_ns: u64) {
        let stale: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry
                    .settled
                    .as_ref()
                    .is_some_and(|(_, at)| expired(*at, now_ns))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            self.remove(&key);
        }
    }

    /// Oldest settled entry only; in-flight (pending) entries are never evicted.
    fn evict_one_settled(&mut self) -> bool {
        let oldest = self
            .entries
            .iter()
            .filter_map(|(key, entry)| {
                entry
                    .settled
                    .as_ref()
                    .map(|(_, at)| (*at, entry.ticket, key))
            })
            .min()
            .map(|(_, _, key)| key.clone());
        oldest.is_some_and(|key| {
            self.remove(&key);
            true
        })
    }

    fn remove(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key)
            && let Some((outcome, _)) = entry.settled
        {
            self.metadata_bytes = self.metadata_bytes.saturating_sub(outcome.bytes());
        }
    }
}

fn expired(settled_at: u64, now_ns: u64) -> bool {
    let retention = u64::try_from(OUTCOME_RETENTION.as_nanos()).unwrap_or(u64::MAX);
    now_ns.saturating_sub(settled_at) >= retention
}

/// `<label>.<sequence>`: non-empty label, canonical decimal sequence > 0.
fn operation_sequence(operation: &str) -> Option<u64> {
    if !valid_id(operation) {
        return None;
    }
    let (label, digits) = operation.rsplit_once('.')?;
    (!label.is_empty()).then_some(())?;
    canonical_number(digits).filter(|sequence| *sequence > 0)
}

fn canonical_number(digits: &str) -> Option<u64> {
    let number = digits.parse::<u64>().ok()?;
    (number.to_string() == digits).then_some(number)
}
