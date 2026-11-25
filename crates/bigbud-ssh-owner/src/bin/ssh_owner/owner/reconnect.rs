//! Admission for background checks and caller-initiated retries. No timer
//! schedules work, and an operation is never retried within its request.
use std::time::{Duration, Instant};

use super::Owner;
use crate::v1::{ErrorCode, ProofHealth};

const BASE_MS: u64 = 250;
const MAX_MS: u64 = 30_000;

#[derive(Default)]
pub(super) struct RetryWindow {
    failures: u32,
    next: Option<Instant>,
}

impl RetryWindow {
    pub(super) fn admit(&self, now: Instant) -> Result<(), ErrorCode> {
        if self.next.is_some_and(|deadline| now < deadline) {
            // A cooldown does not imply a new observation of transport loss.
            return Err(ErrorCode::TransportLost);
        }
        Ok(())
    }

    pub(super) fn record_failure(&mut self, now: Instant, jitter: u64) {
        let ceiling = (BASE_MS << self.failures.min(8)).min(MAX_MS);
        // Equal jitter: a nonzero lower bound, without exceeding the cap.
        let floor = ceiling / 2;
        let wait = floor + jitter % (ceiling - floor + 1);
        self.next = now.checked_add(Duration::from_millis(wait));
        self.failures = self.failures.saturating_add(1);
    }
}

#[derive(Default)]
pub(super) struct ReconnectAdmission {
    retry: RetryWindow,
    paused: Option<ErrorCode>,
}

impl ReconnectAdmission {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    pub(super) fn sample(
        &mut self,
        now: impl Fn() -> Instant,
        jitter: u64,
        probe: impl FnOnce() -> Result<ProofHealth, ErrorCode>,
    ) -> Result<ProofHealth, ErrorCode> {
        if let Some(code) = self.paused {
            return Err(code);
        }
        self.retry.admit(now())?;
        let result = probe();
        match &result {
            Ok(ProofHealth { reachable: true }) => self.reset(),
            Ok(ProofHealth { reachable: false }) | Err(ErrorCode::TransportLost) => {
                self.retry.record_failure(now(), jitter);
            }
            Err(
                code @ (ErrorCode::AuthRequired
                | ErrorCode::TrustRequired
                | ErrorCode::HostKeyChanged
                | ErrorCode::ConfigUnsupported),
            ) => {
                self.retry = RetryWindow::default();
                self.paused = Some(*code);
            }
            // Local failures, cancellation, and ambiguous outcomes are not
            // transport observations. Cleanup quarantine is enforced separately.
            Err(_) => {}
        }
        result
    }
}

impl Owner {
    pub(super) fn sample_picker_health(
        &mut self,
        request_id: &[u8],
    ) -> Result<ProofHealth, ErrorCode> {
        // Direct health opens a new SSH child. A master-selected target must
        // not bypass its lease, trust pause, or explicit password unlock.
        if self.picker_master.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        let seed = self
            .generation
            .first_chunk::<8>()
            .copied()
            .map_or(0, u64::from_le_bytes);
        #[cfg(target_os = "macos")]
        if let Some(inbox) = &mut self.picker_cancel {
            return self.reconnect.sample(Instant::now, seed, || {
                inbox.run(request_id, |cancelled| {
                    self.transport.sample_health_cancellable(cancelled)
                })
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = request_id;
        self.reconnect
            .sample(Instant::now, seed, || self.transport.sample_health())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_after_bounded_jittered_delay_and_resets_after_success() {
        let mut admission = ReconnectAdmission::default();
        let mut instant = Instant::now();
        for attempt in 0_u32..20 {
            assert_eq!(
                admission.sample(|| instant, 0, || Ok(ProofHealth { reachable: false })),
                Ok(ProofHealth { reachable: false })
            );
            let deadline = admission.retry.next.expect("retry is bounded");
            let wait = deadline.duration_since(instant);
            assert_eq!(
                wait,
                Duration::from_millis((BASE_MS << attempt.min(8)).min(MAX_MS) / 2)
            );
            assert_eq!(
                admission.sample(
                    || deadline
                        .checked_sub(Duration::from_millis(1))
                        .expect("instant within test range"),
                    0,
                    || panic!("no probe during cooldown")
                ),
                Err(ErrorCode::TransportLost)
            );
            instant = deadline;
        }
        assert_eq!(
            admission.sample(|| instant, u64::MAX, || Ok(ProofHealth { reachable: true })),
            Ok(ProofHealth { reachable: true })
        );
        assert!(admission.retry.next.is_none());
        assert_eq!(admission.retry.failures, 0);
    }

    #[test]
    fn non_transport_health_errors_do_not_arm_or_extend_transport_cooldown() {
        for code in [
            ErrorCode::OwnerUnavailable,
            ErrorCode::OutcomeUnknown,
            ErrorCode::OperationDenied,
            ErrorCode::InvalidOperands,
        ] {
            // Exercise both a fresh owner and the first request after a real loss.
            for previous_loss in [false, true] {
                let mut admission = ReconnectAdmission::default();
                let mut now = Instant::now();
                if previous_loss {
                    assert_eq!(
                        admission.sample(|| now, 0, || Err(ErrorCode::TransportLost)),
                        Err(ErrorCode::TransportLost)
                    );
                    now += Duration::from_millis(BASE_MS / 2);
                }
                for _ in 0..2 {
                    assert_eq!(admission.sample(|| now, 0, || Err(code)), Err(code));
                }
                assert_eq!(admission.retry.failures, u32::from(previous_loss));
                assert_eq!(
                    admission.sample(|| now, 0, || Ok(ProofHealth { reachable: true })),
                    Ok(ProofHealth { reachable: true })
                );
            }
        }
    }

    #[test]
    fn transport_loss_arms_cooldown_without_replaying_the_probe() {
        let mut admission = ReconnectAdmission::default();
        let now = Instant::now();
        assert_eq!(
            admission.sample(|| now, 0, || Err(ErrorCode::TransportLost)),
            Err(ErrorCode::TransportLost)
        );
        assert_eq!(
            admission.sample(|| now, 0, || panic!("no probe during cooldown")),
            Err(ErrorCode::TransportLost)
        );
        assert_eq!(
            admission.sample(
                || now + Duration::from_millis(BASE_MS / 2),
                0,
                || Ok(ProofHealth { reachable: true })
            ),
            Ok(ProofHealth { reachable: true })
        );
    }

    #[test]
    fn cancelled_health_does_not_create_backoff_or_a_trust_pause() {
        let mut admission = ReconnectAdmission::default();
        let now = Instant::now();
        assert_eq!(
            admission.sample(|| now, 0, || Err(ErrorCode::HealthCancelled)),
            Err(ErrorCode::HealthCancelled)
        );
        assert_eq!(admission.retry.failures, 0);
        assert!(admission.retry.next.is_none());
        assert!(admission.paused.is_none());
        assert_eq!(
            admission.sample(|| now, 0, || Ok(ProofHealth { reachable: true })),
            Ok(ProofHealth { reachable: true })
        );
    }

    #[test]
    fn trust_or_credential_failures_pause_network_until_explicit_reset() {
        let mut admission = ReconnectAdmission::default();
        let instant = Instant::now();
        assert_eq!(
            admission.sample(|| instant, 0, || Err(ErrorCode::HostKeyChanged)),
            Err(ErrorCode::HostKeyChanged)
        );
        assert_eq!(
            admission.sample(
                || instant + Duration::from_secs(60),
                0,
                || panic!("no background trust retry")
            ),
            Err(ErrorCode::HostKeyChanged)
        );
        admission.reset();
        assert_eq!(
            admission.sample(|| instant, 0, || Ok(ProofHealth { reachable: true })),
            Ok(ProofHealth { reachable: true })
        );
    }
}
