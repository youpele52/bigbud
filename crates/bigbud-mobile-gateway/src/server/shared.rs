//! State shared by connection tasks.

use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::config::GatewayConfig;
use crate::headers::ForwardContext;
use crate::rate_limit::PairingLimiter;

pub struct Shared {
    pub config: GatewayConfig,
    pub pairing_limiter: PairingLimiter,
    /// One permit per relayed byte held process-wide (see `max_in_flight_bytes`).
    pub in_flight_bytes: Arc<Semaphore>,
}

impl Shared {
    pub fn new(config: GatewayConfig) -> Self {
        let limits = config.limits;
        Self {
            pairing_limiter: PairingLimiter::new(
                limits.pairing_exchange_per_window,
                limits.pairing_exchange_global_per_window,
                limits.pairing_tracked_ids,
                limits.pairing_exchange_window,
            ),
            in_flight_bytes: Arc::new(Semaphore::new(limits.max_in_flight_bytes)),
            config,
        }
    }

    pub fn forward_context(&self) -> ForwardContext<'_> {
        ForwardContext {
            external_host: self.config.external_origin.host(),
            credential: self.config.upstream_credential.as_deref(),
        }
    }
}

pub fn log_event(event: &str, detail: &str) {
    // Never logs paths, queries, headers or payloads: they may carry tokens.
    eprintln!("bigbud-mobile-gateway event={event} detail={detail}");
}
