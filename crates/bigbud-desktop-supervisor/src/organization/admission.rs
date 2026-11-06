//! Fail-closed compact-state admission, not a scheduler or canonical fact owner.
//! On any error discard this instance and resnapshot under a fresh generation.
use std::collections::{BTreeMap, VecDeque};

use prost::Message;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::admission_validation::{
    MAX_FRAME_BYTES, MAX_SAFE_UINT, row_bytes, valid_envelope, valid_limits, valid_row,
};
use super::protocol::{
    facts::v1::{Fact, ThreadFacts},
    policy::v1::{Limits, Policy},
    v1::{Frame, SnapshotBegin, SnapshotEnd, SnapshotPage, frame::Payload},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AdmissionError {
    #[error("invalid, incompatible or out-of-order organisation frame; resync required")]
    Resync,
    #[error("organisation capacity exceeded; resync required")]
    Capacity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Negotiated,
    Staged,
    Activated,
    Applied,
    Duplicate,
    /// Post-activation policy/barrier update; the session must apply it to the scheduler.
    PolicyUpdated,
}

struct Stored {
    row: ThreadFacts,
    deleted: bool,
}

struct Staging {
    begin: SnapshotBegin,
    pages: u32,
    digest: Sha256,
    last_id: String,
    pending: Vec<Fact>,
    pending_bytes: usize,
}

pub struct CompactState {
    nonce: String,
    generation: u64,
    limits: Option<Limits>,
    fenced: bool,
    active: bool,
    rows: BTreeMap<String, Stored>,
    bytes: usize,
    sequence: u64,
    source_frontier: u64,
    policy_version: u64,
    policy: Option<Policy>,
    staging: Option<Staging>,
    recent: VecDeque<Fact>,
    recent_bytes: usize,
}

impl CompactState {
    pub fn new(nonce: String, generation: u64) -> Self {
        let fenced =
            nonce.is_empty() || nonce.len() > 256 || generation == 0 || generation > MAX_SAFE_UINT;
        Self {
            nonce,
            generation,
            fenced,
            limits: None,
            active: false,
            rows: BTreeMap::new(),
            bytes: 0,
            sequence: 0,
            source_frontier: 0,
            policy_version: 0,
            policy: None,
            staging: None,
            recent: VecDeque::new(),
            recent_bytes: 0,
        }
    }

    /// No usable state is exposed until the whole snapshot and queued suffix validate.
    pub fn rows(&self) -> Option<impl Iterator<Item = &ThreadFacts>> {
        self.active.then(|| {
            self.rows
                .values()
                .filter(|stored| !stored.deleted)
                .map(|stored| &stored.row)
        })
    }

    pub fn row(&self, id: &str) -> Option<&ThreadFacts> {
        if !self.active {
            return None;
        }
        self.rows
            .get(id)
            .filter(|stored| !stored.deleted)
            .map(|stored| &stored.row)
    }

    pub fn frontier(&self) -> Option<(u64, u64, u64)> {
        self.active
            .then_some((self.sequence, self.source_frontier, self.policy_version))
    }

    pub fn policy(&self) -> Option<&Policy> {
        if self.active {
            self.policy.as_ref()
        } else {
            None
        }
    }

    /// Payload only, after a bounded transport has checked its length prefix.
    pub fn admit(&mut self, bytes: &[u8]) -> Result<Admission, AdmissionError> {
        let maximum = self
            .limits
            .as_ref()
            .map_or(MAX_FRAME_BYTES, |limits| limits.frame_bytes as usize);
        let result = if bytes.is_empty() || bytes.len() > maximum {
            Err(AdmissionError::Capacity)
        } else if !valid_envelope(bytes) {
            Err(AdmissionError::Resync)
        } else {
            Frame::decode(bytes)
                .map_err(|_| AdmissionError::Resync)
                .and_then(|frame| self.apply(frame, bytes.len()))
        };
        if result.is_err() {
            self.fenced = true;
            self.active = false;
            self.rows.clear();
            self.bytes = 0;
            self.staging = None;
            self.policy = None;
            self.recent.clear();
            self.recent_bytes = 0;
        }
        result
    }

    fn apply(&mut self, frame: Frame, received_bytes: usize) -> Result<Admission, AdmissionError> {
        if self.fenced || frame.backend_nonce != self.nonce || frame.generation != self.generation {
            return Err(AdmissionError::Resync);
        }
        if let Some(Payload::Hello(hello)) = frame.payload.as_ref() {
            let limits = hello.limits.as_ref().ok_or(AdmissionError::Resync)?;
            if self.limits.is_some()
                || hello.major != 1
                || hello.minor != 0
                || hello.capability != "compact-facts-v1"
                || !valid_limits(limits)
                || received_bytes > limits.frame_bytes as usize
            {
                return Err(AdmissionError::Resync);
            }
            self.limits = Some(*limits);
            return Ok(Admission::Negotiated);
        }
        let limits = self.limits.ok_or(AdmissionError::Resync)?;
        match frame.payload.ok_or(AdmissionError::Resync)? {
            Payload::Begin(begin) => self.begin(begin),
            Payload::Page(page) => self.page(page, limits),
            Payload::End(end) => self.end(end, limits),
            Payload::Fact(fact) => self.fact(fact, limits),
            Payload::Policy(policy) => self.update_policy(policy),
            Payload::Hello(_) | Payload::Receipt(_) | Payload::Heartbeat(_) => {
                Err(AdmissionError::Resync)
            }
        }
    }

    fn begin(&mut self, begin: SnapshotBegin) -> Result<Admission, AdmissionError> {
        let policy = begin.policy.as_ref().ok_or(AdmissionError::Resync)?;
        if self.active
            || self.staging.is_some()
            || begin.snapshot_id.is_empty()
            || begin.snapshot_id.len() > 256
            || begin.sequence > MAX_SAFE_UINT
            || begin.source_frontier > MAX_SAFE_UINT
            || policy.version == 0
            || policy.version > MAX_SAFE_UINT
            || policy.fingerprint.is_empty()
            || policy.fingerprint.len() > 256
            || policy
                .older_policy_changed_at_ms
                .is_some_and(|v| v > MAX_SAFE_UINT)
        {
            return Err(AdmissionError::Resync);
        }
        self.sequence = begin.sequence;
        self.source_frontier = begin.source_frontier;
        self.policy_version = policy.version;
        self.policy = Some(policy.clone());
        self.staging = Some(Staging {
            begin,
            pages: 0,
            digest: Sha256::new(),
            last_id: String::new(),
            pending: Vec::new(),
            pending_bytes: 0,
        });
        Ok(Admission::Staged)
    }

    fn page(&mut self, page: SnapshotPage, limits: Limits) -> Result<Admission, AdmissionError> {
        let stage = self.staging.as_mut().ok_or(AdmissionError::Resync)?;
        if page.snapshot_id != stage.begin.snapshot_id
            || page.index != stage.pages
            || page.rows.is_empty()
        {
            return Err(AdmissionError::Resync);
        }
        if page.rows.len() > limits.page_rows as usize
            || self.rows.len() + page.rows.len() > limits.live_rows as usize
        {
            return Err(AdmissionError::Capacity);
        }
        for row in page.rows {
            if !valid_row(&row) || row.thread_id <= stage.last_id {
                return Err(AdmissionError::Resync);
            }
            self.bytes += row_bytes(&row);
            if self.bytes > limits.state_bytes as usize {
                return Err(AdmissionError::Capacity);
            }
            let encoded = row.encode_to_vec();
            stage.digest.update((encoded.len() as u32).to_be_bytes());
            stage.digest.update(&encoded);
            stage.last_id.clone_from(&row.thread_id);
            self.rows.insert(
                row.thread_id.clone(),
                Stored {
                    row,
                    deleted: false,
                },
            );
        }
        stage.pages += 1;
        Ok(Admission::Staged)
    }

    fn end(&mut self, end: SnapshotEnd, limits: Limits) -> Result<Admission, AdmissionError> {
        let stage = self.staging.take().ok_or(AdmissionError::Resync)?;
        if end.snapshot_id != stage.begin.snapshot_id
            || end.pages != stage.pages
            || end.rows as usize != self.rows.len()
            || end.policy_version != self.policy_version
            || end.digest != stage.digest.finalize().as_slice()
        {
            return Err(AdmissionError::Resync);
        }
        for fact in stage.pending {
            self.apply_fact(fact.clone(), limits)?;
            self.remember(fact, limits);
        }
        self.active = true;
        Ok(Admission::Activated)
    }

    fn fact(&mut self, fact: Fact, limits: Limits) -> Result<Admission, AdmissionError> {
        if fact.sequence <= self.sequence {
            let prior = if let Some(stage) = &self.staging {
                stage
                    .pending
                    .iter()
                    .find(|prior| prior.sequence == fact.sequence)
            } else {
                self.recent
                    .iter()
                    .find(|prior| prior.sequence == fact.sequence)
            };
            return if prior == Some(&fact) {
                Ok(Admission::Duplicate)
            } else {
                Err(AdmissionError::Resync)
            };
        }
        if fact.sequence > MAX_SAFE_UINT
            || fact.sequence != self.sequence + 1
            || fact.source_frontier < self.source_frontier
            || fact.source_frontier > MAX_SAFE_UINT
            || !fact.row.as_ref().is_some_and(valid_row)
        {
            return Err(AdmissionError::Resync);
        }
        if let Some(stage) = self.staging.as_mut() {
            stage.pending_bytes += fact.encoded_len();
            if stage.pending.len() >= limits.pending_facts as usize
                || stage.pending_bytes > limits.pending_bytes as usize
            {
                return Err(AdmissionError::Capacity);
            }
            stage.pending.push(fact.clone());
        } else if self.active {
            self.apply_fact(fact.clone(), limits)?;
            self.remember(fact.clone(), limits);
        } else {
            return Err(AdmissionError::Resync);
        }
        self.sequence = fact.sequence;
        self.source_frontier = fact.source_frontier;
        Ok(if self.active {
            Admission::Applied
        } else {
            Admission::Staged
        })
    }

    // Duplicates outside this bounded suffix require resync, never silent acceptance.
    fn remember(&mut self, fact: Fact, limits: Limits) {
        self.recent_bytes += fact.encoded_len();
        self.recent.push_back(fact);
        while self.recent.len() > limits.pending_facts as usize
            || self.recent_bytes > limits.pending_bytes as usize
        {
            if let Some(old) = self.recent.pop_front() {
                self.recent_bytes -= old.encoded_len();
            }
        }
    }

    fn apply_fact(&mut self, fact: Fact, limits: Limits) -> Result<(), AdmissionError> {
        let row = fact.row.ok_or(AdmissionError::Resync)?;
        let previous = self.rows.get(&row.thread_id);
        if previous.is_some_and(|stored| {
            row.fact_version <= stored.row.fact_version
                || row.organization_revision < stored.row.organization_revision
                || row.attention_watermark < stored.row.attention_watermark
        }) {
            return Err(AdmissionError::Resync);
        }
        if previous.is_none() && self.rows.len() >= limits.live_rows as usize {
            return Err(AdmissionError::Capacity);
        }
        self.bytes =
            self.bytes - previous.map_or(0, |stored| row_bytes(&stored.row)) + row_bytes(&row);
        if self.bytes > limits.state_bytes as usize {
            return Err(AdmissionError::Capacity);
        }
        self.rows.insert(
            row.thread_id.clone(),
            Stored {
                row,
                deleted: fact.deleted,
            },
        );
        Ok(())
    }
}

#[path = "admission_policy.rs"]
mod policy_update;

#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
