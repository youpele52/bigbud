//! Native scheduling session. A fresh owner generation requires a complete validated snapshot.
use super::admission::{Admission, CompactState};
use super::admission_wire::valid_envelope;
use super::protocol::{
    facts::v1::Section,
    policy::v1::Policy,
    scheduling::v1::{Heartbeat, NativeFrame, Ready, native_frame},
    v1::{Frame, frame},
};
use super::scheduler::{Scheduler, SchedulingFacts, SchedulingPolicy};
use super::session_operations::Operations;
use super::timing::{ClockSample, RuleWait};
use prost::Message;

pub struct Session {
    nonce: String,
    generation: u64,
    state: CompactState,
    scheduler: Option<Scheduler>,
    operations: Operations,
    started_ms: u64,
    progress_ms: u64,
    owner_ms: u64,
    heartbeat_ms: u64,
    maximum: usize,
    negotiated: bool,
    dirty: bool,
    decision_ms: u64,
    pass_ms: Option<u64>,
}
/// A full decision pass is O(rows); bursts of admitted facts coalesce into one pass per window.
pub const DECISION_SPACING_MS: u64 = 250;
impl Session {
    pub fn new(nonce: String, generation: u64, now: ClockSample) -> Self {
        Self {
            state: CompactState::new(nonce.clone(), generation),
            nonce,
            generation,
            scheduler: None,
            operations: Operations::default(),
            started_ms: now.monotonic_ms,
            progress_ms: now.monotonic_ms,
            owner_ms: now.monotonic_ms,
            heartbeat_ms: now.monotonic_ms,
            maximum: 1_048_576,
            negotiated: false,
            dirty: true,
            decision_ms: now.monotonic_ms,
            pass_ms: None,
        }
    }
    pub fn receive(
        &mut self,
        bytes: &[u8],
        now: ClockSample,
    ) -> Result<Vec<NativeFrame>, &'static str> {
        if bytes.is_empty() || bytes.len() > self.maximum || !valid_envelope(bytes) {
            return Err("invalid organisation wire frame");
        }
        let frame = Frame::decode(bytes).map_err(|_| "invalid organisation protobuf")?;
        if frame.backend_nonce != self.nonce || frame.generation != self.generation {
            return Err("stale organisation generation");
        }
        let complete = |row: &super::protocol::facts::v1::ThreadFacts| {
            row.in_scope.is_some() && row.manual_attention_watermark.is_some()
        };
        match frame.payload.as_ref() {
            Some(frame::Payload::Page(page)) if page.rows.iter().any(|row| !complete(row)) => {
                return Err("scope/attention facts absent");
            }
            Some(frame::Payload::Fact(fact))
                if fact.row.as_ref().is_none_or(|row| !complete(row)) =>
            {
                return Err("scope/attention facts absent");
            }
            _ => {}
        }
        self.owner_ms = now.monotonic_ms;
        match frame.payload.as_ref() {
            Some(frame::Payload::Receipt(receipt)) => {
                self.state.frontier().ok_or("receipt before activation")?;
                self.operations.receive(receipt.clone(), now.monotonic_ms)?;
                self.dirty = true;
                return Ok(Vec::new());
            }
            Some(frame::Payload::Heartbeat(heartbeat)) => {
                let (sequence, _, _) =
                    self.state.frontier().ok_or("heartbeat before activation")?;
                if heartbeat.sequence > sequence {
                    return Err("owner heartbeat ahead of admitted facts");
                }
                return Ok(Vec::new());
            }
            _ => {}
        }
        let admitted = self
            .state
            .admit(bytes)
            .map_err(|_| "organisation facts require resynchronisation")?;
        self.progress_ms = now.monotonic_ms;
        self.dirty = true;
        if admitted == Admission::Negotiated {
            self.negotiated = true;
            let Some(frame::Payload::Hello(hello)) = frame.payload else {
                return Err("invalid negotiated frame");
            };
            self.maximum = hello.limits.ok_or("missing negotiated limits")?.frame_bytes as usize;
        }
        if admitted == Admission::PolicyUpdated {
            let policy = self.state.policy().ok_or("policy update lacks policy")?;
            let policy = scheduling_policy(policy)?;
            self.scheduler
                .as_mut()
                .ok_or("policy update before activation")?
                .update_policy(now, policy)
                .map_err(|_| "invalid scheduling policy update")?;
        }
        if admitted == Admission::Activated {
            let policy = self.state.policy().ok_or("activation lacks policy")?;
            self.scheduler = Some(
                Scheduler::new(
                    now,
                    policy.older_policy_changed_at_ms.map(|value| value as i64),
                    scheduling_policy(policy)?,
                )
                .map_err(|_| "invalid scheduling policy")?,
            );
            if self
                .state
                .rows()
                .ok_or("missing active facts")?
                .any(|row| row.in_scope.is_none() || row.manual_attention_watermark.is_none())
            {
                return Err("scheduling requires explicit scope and manual attention facts");
            }
            let (sequence, _, policy_version) =
                self.state.frontier().ok_or("missing active frontier")?;
            return Ok(vec![self.output(native_frame::Payload::Ready(Ready {
                sequence,
                policy_version,
            }))]);
        }
        Ok(Vec::new())
    }
    pub fn tick(&mut self, now: ClockSample) -> Result<Vec<NativeFrame>, &'static str> {
        if now.monotonic_ms.saturating_sub(self.owner_ms) > 15_000 {
            return Err("organisation owner heartbeat timed out");
        }
        if !self.negotiated && now.monotonic_ms.saturating_sub(self.started_ms) > 5000 {
            return Err("organisation hello timed out");
        }
        if self.scheduler.is_none() {
            if now.monotonic_ms.saturating_sub(self.started_ms) > 60_000
                || now.monotonic_ms.saturating_sub(self.progress_ms) > 10_000
            {
                return Err("organisation snapshot timed out");
            }
            return Ok(Vec::new());
        }
        let wall = u64::try_from(now.wall_ms).map_err(|_| "invalid wall clock")?;
        if wall > 9_007_199_254_740_991 {
            return Err("wall clock outside protocol range");
        }
        let mut output = Vec::new();
        let state = &self.state;
        if let Some(proposal) = self.operations.tick(wall, now.monotonic_ms, |proposal| {
            state.row(&proposal.thread_id).is_some_and(|row| {
                row.fact_version == proposal.fact_version
                    && row.organization_revision == proposal.expected_revision
            })
        })? {
            output.push(self.output(native_frame::Payload::Proposal(proposal)));
        }
        let (sequence, _, _) = self.state.frontier().ok_or("missing active frontier")?;
        let spaced = self
            .pass_ms
            .is_none_or(|last| now.monotonic_ms.saturating_sub(last) >= DECISION_SPACING_MS);
        if !self.operations.pending()
            && !self.operations.at_capacity()
            && (self.dirty && spaced || now.monotonic_ms >= self.decision_ms)
        {
            self.dirty = false;
            self.pass_ms = Some(now.monotonic_ms);
            let mut delay = self
                .operations
                .next_unblock_ms(now.monotonic_ms)
                .map_or(15_000, |until| (until - now.monotonic_ms).min(15_000));
            let rows: Vec<_> = self
                .state
                .rows()
                .ok_or("missing active facts")?
                .map(|row| SchedulingFacts {
                    row,
                    in_scope: row.in_scope == Some(true),
                    manual_attention_watermark: row.manual_attention_watermark.unwrap_or(0),
                    engaged_until_ms: row.engaged_until_ms,
                    decision_allowed: self.operations.allows_thread(
                        &row.thread_id,
                        row.fact_version,
                        now.monotonic_ms,
                    ),
                })
                .collect();
            for facts in &rows {
                for deadline in [
                    facts.row.manual_until_ms,
                    facts.row.snooze_until_ms,
                    facts.row.grace_until_ms,
                    facts.engaged_until_ms,
                ]
                .into_iter()
                .flatten()
                {
                    if deadline > wall {
                        delay = delay.min(deadline - wall);
                    }
                }
            }
            if let Some(deadline) = self
                .state
                .policy()
                .and_then(|policy| policy.scheduling.as_ref())
                .and_then(|settings| settings.target_not_before_ms)
                && deadline > wall
            {
                delay = delay.min(deadline - wall);
            }
            self.decision_ms = now.monotonic_ms.saturating_add(delay);
            let scheduler = self.scheduler.as_mut().ok_or("scheduler not active")?;
            if let Some(movement) = scheduler.next(now, &rows) {
                let proposal = self.operations.start(
                    movement,
                    &self.nonce,
                    self.generation,
                    sequence,
                    wall,
                    now.monotonic_ms,
                );
                output.push(self.output(native_frame::Payload::Proposal(proposal)));
            }
            let state = &self.state;
            self.operations.retain_threads(|id| state.row(id).is_some());
        }
        if now.monotonic_ms.saturating_sub(self.heartbeat_ms) >= 5000 {
            self.heartbeat_ms = now.monotonic_ms;
            output.push(self.output(native_frame::Payload::Heartbeat(Heartbeat { sequence })));
        }
        Ok(output)
    }
    pub fn maximum(&self) -> usize {
        self.maximum
    }
    fn output(&self, payload: native_frame::Payload) -> NativeFrame {
        NativeFrame {
            backend_nonce: self.nonce.clone(),
            generation: self.generation,
            payload: Some(payload),
        }
    }
}
fn scheduling_policy(policy: &Policy) -> Result<SchedulingPolicy, &'static str> {
    let settings = policy
        .scheduling
        .as_ref()
        .ok_or("scheduling settings absent")?;
    if [
        settings.idle_timeout_ms,
        settings.older_timeout_ms,
        settings.grace_ms,
    ]
    .into_iter()
    .any(|value| value > 9_007_199_254_740_991)
        || settings
            .target_not_before_ms
            .is_some_and(|value| value > 9_007_199_254_740_991)
    {
        return Err("scheduling time exceeds protocol bounds");
    }
    Ok(SchedulingPolicy {
        version: policy.version,
        idle: RuleWait {
            enabled: settings.idle_enabled,
            timeout_ms: settings.idle_timeout_ms,
        },
        idle_destination: Section::try_from(settings.idle_destination)
            .map_err(|_| "invalid idle destination")?,
        older: RuleWait {
            enabled: settings.older_enabled,
            timeout_ms: settings.older_timeout_ms,
        },
        target: settings.present_target.map(|value| value as usize),
        target_not_before_ms: settings.target_not_before_ms,
        grace_ms: settings.grace_ms,
    })
}
