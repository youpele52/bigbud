//! `admission::decide`: the hard limit on managed live PTYs (plan §8.8). The limit counts only
//! managed live PTYs; the "oldest" is the least recently used, busy or not, never a visible
//! one. Eviction happens only for a candidate the caller confirmed and the host re-checked.

use super::policy::HostPolicy;

/// One live PTY (exited and lost sessions are not passed in).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionEntry<'a> {
    pub pty_id: &'a str,
    pub managed: bool,
    pub visible: bool,
    pub last_used_ms: u64,
    /// Reported with the candidate so the UI can warn about closing a busy terminal.
    pub busy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionRequest<'a> {
    pub managed: bool,
    /// `PtyCreateRequest.evict_pty_id`: the candidate the user agreed to close.
    pub evict_pty_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictionCandidate {
    pub pty_id: String,
    pub last_used_ms: u64,
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionDecision {
    Admit,
    /// Close this PTY (`limit_closed`), then create the new one.
    Evict {
        pty_id: String,
    },
    /// `PTY_LIMIT_REACHED` with a fresh candidate, if any PTY may be evicted.
    Refuse {
        limit: u32,
        live_count: u32,
        candidate: Option<EvictionCandidate>,
    },
}

pub fn decide(
    policy: &HostPolicy,
    live: &[AdmissionEntry<'_>],
    request: AdmissionRequest<'_>,
) -> AdmissionDecision {
    if !policy.lifecycle_enabled || !request.managed {
        return AdmissionDecision::Admit;
    }
    let limit = policy.max_live_ptys;
    let managed = live.iter().filter(|entry| entry.managed);
    let live_count = u32::try_from(managed.clone().count()).unwrap_or(u32::MAX);
    if live_count < limit {
        return AdmissionDecision::Admit;
    }
    let evictable = |entry: &&AdmissionEntry<'_>| entry.managed && !entry.visible;
    // Evicting one only admits when it brings the count under the (possibly lowered) limit.
    if live_count.saturating_sub(1) < limit
        && let Some(requested) = request.evict_pty_id
        && live
            .iter()
            .filter(evictable)
            .any(|entry| entry.pty_id == requested)
    {
        return AdmissionDecision::Evict {
            pty_id: requested.to_owned(),
        };
    }
    let candidate = managed
        .filter(|entry| !entry.visible)
        .min_by_key(|entry| (entry.last_used_ms, entry.pty_id))
        .map(|entry| EvictionCandidate {
            pty_id: entry.pty_id.to_owned(),
            last_used_ms: entry.last_used_ms,
            busy: entry.busy,
        });
    AdmissionDecision::Refuse {
        limit,
        live_count,
        candidate,
    }
}
