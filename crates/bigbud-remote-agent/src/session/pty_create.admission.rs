//! The hard limit on managed live PTYs and atomic eviction (plan §8.8, §9.1 "Eviction is
//! atomic in the host"). Only managed creates on a host with lifecycle enabled are limited;
//! the host re-checks a confirmed candidate under its PTY lock before closing it.

use bigbud_protocol::pty_lifecycle::PTY_LIMIT_REACHED;

use super::super::pty_lifecycle_host::kind;
use super::*;
use crate::terminal_policy::ViewState;
use crate::terminal_policy::admission::{
    AdmissionDecision, AdmissionEntry, AdmissionRequest, decide,
};

pub(super) enum Admission {
    Admit { evicted: Option<String> },
    Refuse(Box<v1::Frame>),
}

struct Facts {
    pty_id: String,
    managed: bool,
    visible: bool,
    last_used_ms: u64,
    busy: bool,
}

impl AgentSession {
    fn live_facts(&self) -> Vec<Facts> {
        self.pty_sessions
            .values()
            .filter_map(|session| session.lifecycle.as_ref())
            .filter(|lifecycle| lifecycle.is_live())
            .map(|lifecycle| {
                let state = lifecycle.lock();
                Facts {
                    pty_id: lifecycle.pty_id().to_owned(),
                    managed: lifecycle.managed(),
                    visible: state.activity.view_state() == ViewState::Visible,
                    last_used_ms: state.activity.last_used(),
                    busy: state.activity.idle_busy(),
                }
            })
            .collect()
    }

    /// `(limit, managed live count)` for create responses.
    pub(super) fn managed_live_counts(&self) -> (u32, u32) {
        let limit = self
            .terminal_host
            .as_ref()
            .map_or(0, |host| host.policy().max_live_ptys);
        let live = self
            .live_facts()
            .iter()
            .filter(|facts| facts.managed)
            .count();
        (limit, u32::try_from(live).unwrap_or(u32::MAX))
    }

    pub(super) fn admit_pty(&mut self, request: &v1::PtyCreateRequest) -> Admission {
        let Some(host) = self.terminal_host.clone() else {
            return Admission::Admit { evicted: None };
        };
        if !request.lifecycle_managed {
            return Admission::Admit { evicted: None };
        }
        let policy = host.policy();
        let evict = (!request.evict_pty_id.is_empty()).then_some(request.evict_pty_id.as_str());
        // Two rounds at most: a confirmed candidate that vanished gets one fresh decision.
        for _ in 0..2 {
            let facts = self.live_facts();
            let entries = facts
                .iter()
                .map(|facts| AdmissionEntry {
                    pty_id: &facts.pty_id,
                    managed: facts.managed,
                    visible: facts.visible,
                    last_used_ms: facts.last_used_ms,
                    busy: facts.busy,
                })
                .collect::<Vec<_>>();
            let decision = decide(
                &policy,
                &entries,
                AdmissionRequest {
                    managed: true,
                    evict_pty_id: evict,
                },
            );
            match decision {
                AdmissionDecision::Admit => return Admission::Admit { evicted: None },
                AdmissionDecision::Evict { pty_id } => {
                    let closed = self
                        .pty_sessions
                        .get(&pty_id)
                        .and_then(|session| session.lifecycle.clone())
                        .is_some_and(|lifecycle| {
                            lifecycle.close_if(kind::LIMIT_CLOSED, |activity, _| {
                                activity.lifecycle_managed()
                                    && activity.view_state() == ViewState::Hidden
                            })
                        });
                    if closed {
                        self.note_pty_closed(&pty_id);
                        return Admission::Admit {
                            evicted: Some(pty_id),
                        };
                    }
                }
                AdmissionDecision::Refuse {
                    limit,
                    live_count,
                    candidate,
                } => {
                    return Admission::Refuse(Box::new(limit_refusal(
                        request, limit, live_count, candidate,
                    )));
                }
            }
        }
        let (limit, live_count) = self.managed_live_counts();
        Admission::Refuse(Box::new(limit_refusal(request, limit, live_count, None)))
    }
}

fn limit_refusal(
    request: &v1::PtyCreateRequest,
    limit: u32,
    live_count: u32,
    candidate: Option<crate::terminal_policy::admission::EvictionCandidate>,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyCreateResponse(
            v1::PtyCreateResponse {
                request_id: request.request_id.clone(),
                pty_id: request.pty_id.clone(),
                accepted: false,
                error_code: PTY_LIMIT_REACHED.to_owned(),
                error_message: format!("terminal limit ({limit}) reached"),
                limit,
                live_count,
                eviction_candidate_pty_id: candidate.map(|c| c.pty_id).unwrap_or_default(),
                ..Default::default()
            },
        )),
    }
}
