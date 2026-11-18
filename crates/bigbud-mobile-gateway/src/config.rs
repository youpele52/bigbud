//! Validated gateway configuration. Listen and upstream addresses must be
//! loopback (or an owner-only Unix socket): exposure happens only through
//! Tailscale Serve, never by binding a public interface.

use std::net::SocketAddr;
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

/// Explicit resource budgets. Defaults follow the mobile access plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Largest phone-to-backend WebSocket message, across fragments.
    pub max_inbound_ws_message_bytes: usize,
    /// Largest backend-to-phone WebSocket message. 4 MiB matches the plan's
    /// initial budget and the server's 4 MiB recovery capture; recovery
    /// batches are at most 256 KiB and thread pages carry a 512 KiB text
    /// budget. The mobile baseline snapshot has no server byte budget yet, so
    /// a larger one closes with 1013 until the server bounds or paginates it.
    pub max_outbound_ws_message_bytes: usize,
    /// Process-wide bytes of relayed messages that may be held at once (read
    /// and waiting to be written, or being written). A message that cannot be
    /// admitted within the write deadline closes its connection.
    pub max_in_flight_bytes: usize,
    /// Bytes tungstenite may hold unsent per socket before writes backpressure.
    pub ws_write_buffer_bytes: usize,
    /// A WebSocket with no message in either direction for this long is closed.
    pub ws_idle_timeout: Duration,
    pub max_connections: usize,
    pub upstream_connect_timeout: Duration,
    pub head_read_timeout: Duration,
    pub max_head_bytes: usize,
    pub max_request_body_bytes: usize,
    /// Largest pairing response accepted from the backend.
    pub max_upstream_response_bytes: usize,
    /// Deadline for one forwarded pairing request, end to end.
    pub upstream_request_timeout: Duration,
    /// A peer that cannot accept output for this long is disconnected.
    pub write_timeout: Duration,
    pub max_asset_bytes: u64,
    /// Exchange attempts allowed per window for one pairing ID.
    pub pairing_exchange_per_window: usize,
    /// Exchange attempts allowed per window across all pairing IDs.
    pub pairing_exchange_global_per_window: usize,
    /// Distinct pairing IDs tracked at once; attempts for new IDs beyond this are refused.
    pub pairing_tracked_ids: usize,
    pub pairing_exchange_window: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_inbound_ws_message_bytes: 1024 * 1024,
            max_outbound_ws_message_bytes: 4 * 1024 * 1024,
            max_in_flight_bytes: 32 * 1024 * 1024,
            ws_write_buffer_bytes: 256 * 1024,
            ws_idle_timeout: Duration::from_secs(120),
            max_connections: 16,
            upstream_connect_timeout: Duration::from_secs(10),
            head_read_timeout: Duration::from_secs(10),
            max_head_bytes: 16 * 1024,
            max_request_body_bytes: 64 * 1024,
            max_upstream_response_bytes: 256 * 1024,
            upstream_request_timeout: Duration::from_secs(15),
            write_timeout: Duration::from_secs(30),
            max_asset_bytes: 16 * 1024 * 1024,
            pairing_exchange_per_window: 10,
            pairing_exchange_global_per_window: 120,
            pairing_tracked_ids: 256,
            pairing_exchange_window: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

/// The HTTPS origin phones use, for example `https://desktop.tailnet.ts.net`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalOrigin {
    host: String,
}

impl ExternalOrigin {
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let invalid = || ConfigError::InvalidExternalOrigin(value.to_owned());
        let host = value.strip_prefix("https://").ok_or_else(invalid)?;
        let host = host.strip_suffix('/').unwrap_or(host);
        let (name, port) = match host.rsplit_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        };
        let name_ok = !name.is_empty()
            && name.len() <= 253
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.');
        let port_ok = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|port| port > 0));
        if !name_ok || !port_ok {
            return Err(invalid());
        }
        Ok(Self {
            host: host.to_ascii_lowercase(),
        })
    }

    /// `host[:port]` for the forwarded Host header.
    pub fn host(&self) -> &str {
        &self.host
    }
}

#[derive(Clone)]
pub struct GatewayConfig {
    pub listen: SocketAddr,
    pub upstream: Upstream,
    pub external_origin: ExternalOrigin,
    pub assets_dir: Option<std::path::PathBuf>,
    /// Startup-generated secret attached to upstream requests. Never logged.
    pub upstream_credential: Option<String>,
    pub limits: Limits,
}

/// Hand-written so the upstream credential can never reach logs or panics.
impl std::fmt::Debug for GatewayConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GatewayConfig")
            .field("listen", &self.listen)
            .field("upstream", &self.upstream)
            .field("external_origin", &self.external_origin)
            .field("assets_dir", &self.assets_dir)
            .field(
                "upstream_credential",
                &self.upstream_credential.as_ref().map(|_| "<redacted>"),
            )
            .field("limits", &self.limits)
            .finish()
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("listen address must be loopback")]
    NonLoopbackListen,
    #[error("upstream address must be loopback")]
    NonLoopbackUpstream,
    #[error("external origin must be an https origin without a path: {0}")]
    InvalidExternalOrigin(String),
    #[error("upstream credential must be 32-256 visible ASCII characters")]
    InvalidCredential,
    #[error("an upstream credential is required (no unauthenticated upstream)")]
    MissingUpstreamCredential,
    #[error("limit {0} must be greater than zero")]
    InvalidLimit(&'static str),
    #[error("assets directory is not a readable directory")]
    InvalidAssetsDir,
}

impl GatewayConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !self.listen.ip().is_loopback() {
            return Err(ConfigError::NonLoopbackListen);
        }
        if let Upstream::Tcp(address) = &self.upstream
            && !address.ip().is_loopback()
        {
            return Err(ConfigError::NonLoopbackUpstream);
        }
        // Always required: any local process can bind a free loopback port, and
        // a Unix socket path's permissions do not prove who created it. The
        // credential lets the backend tell the gateway from an impostor.
        if self.upstream_credential.is_none() {
            return Err(ConfigError::MissingUpstreamCredential);
        }
        if let Some(credential) = &self.upstream_credential {
            let visible = credential.bytes().all(|byte| byte.is_ascii_graphic());
            if !visible || credential.len() < 32 || credential.len() > 256 {
                return Err(ConfigError::InvalidCredential);
            }
        }
        if let Some(dir) = &self.assets_dir
            && !dir.is_dir()
        {
            return Err(ConfigError::InvalidAssetsDir);
        }
        let limits = &self.limits;
        let checks = [
            (
                "max_inbound_ws_message_bytes",
                limits.max_inbound_ws_message_bytes > 0,
            ),
            (
                "max_outbound_ws_message_bytes",
                limits.max_outbound_ws_message_bytes > 0,
            ),
            ("ws_write_buffer_bytes", limits.ws_write_buffer_bytes > 0),
            (
                "max_in_flight_bytes",
                limits.max_in_flight_bytes >= limits.max_outbound_ws_message_bytes
                    && limits.max_in_flight_bytes >= limits.max_inbound_ws_message_bytes
                    && u32::try_from(limits.max_in_flight_bytes).is_ok(),
            ),
            ("max_connections", limits.max_connections > 0),
            // hyper rejects read buffers below 8 KiB.
            ("max_head_bytes", limits.max_head_bytes >= 8192),
            ("max_asset_bytes", limits.max_asset_bytes > 0),
            ("max_request_body_bytes", limits.max_request_body_bytes > 0),
            (
                "max_upstream_response_bytes",
                limits.max_upstream_response_bytes > 0,
            ),
            ("ws_idle_timeout", !limits.ws_idle_timeout.is_zero()),
            (
                "pairing_exchange_per_window",
                limits.pairing_exchange_per_window > 0,
            ),
            (
                "pairing_exchange_global_per_window",
                limits.pairing_exchange_global_per_window >= limits.pairing_exchange_per_window,
            ),
            ("pairing_tracked_ids", limits.pairing_tracked_ids > 0),
            (
                "pairing_exchange_window",
                !limits.pairing_exchange_window.is_zero(),
            ),
        ];
        match checks.iter().find(|(_, ok)| !ok) {
            Some((name, _)) => Err(ConfigError::InvalidLimit(name)),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> GatewayConfig {
        GatewayConfig {
            listen: "127.0.0.1:0".parse().unwrap(),
            upstream: Upstream::Tcp("127.0.0.1:3773".parse().unwrap()),
            external_origin: ExternalOrigin::parse("https://desk.tail1.ts.net").unwrap(),
            assets_dir: None,
            upstream_credential: Some("c".repeat(32)),
            limits: Limits::default(),
        }
    }

    #[test]
    fn rejects_public_listen_and_upstream_addresses() {
        let mut public_listen = config();
        public_listen.listen = "0.0.0.0:8080".parse().unwrap();
        assert_eq!(
            public_listen.validate(),
            Err(ConfigError::NonLoopbackListen)
        );

        let mut public_upstream = config();
        public_upstream.upstream = Upstream::Tcp("192.168.1.2:3773".parse().unwrap());
        assert_eq!(
            public_upstream.validate(),
            Err(ConfigError::NonLoopbackUpstream)
        );
        assert_eq!(config().validate(), Ok(()));
    }

    #[test]
    fn external_origin_must_be_https_without_path() {
        assert!(ExternalOrigin::parse("http://desk.ts.net").is_err());
        assert!(ExternalOrigin::parse("https://desk.ts.net/mobile").is_err());
        assert!(ExternalOrigin::parse("https://").is_err());
        assert!(ExternalOrigin::parse("https://desk.ts.net:0").is_err());
        assert!(ExternalOrigin::parse("https://de\r\nsk").is_err());
        let origin = ExternalOrigin::parse("https://Desk.TS.net:8443/").unwrap();
        assert_eq!(origin.host(), "desk.ts.net:8443");
    }

    #[test]
    fn requires_a_credential_for_every_upstream() {
        let mut anonymous = config();
        anonymous.upstream_credential = None;
        assert_eq!(
            anonymous.validate(),
            Err(ConfigError::MissingUpstreamCredential)
        );
        #[cfg(unix)]
        {
            anonymous.upstream = Upstream::Unix("/tmp/backend.sock".into());
            assert_eq!(
                anonymous.validate(),
                Err(ConfigError::MissingUpstreamCredential)
            );
        }
    }

    #[test]
    fn in_flight_budget_must_hold_one_maximum_message() {
        let mut small = config();
        small.limits.max_in_flight_bytes = small.limits.max_outbound_ws_message_bytes - 1;
        assert_eq!(
            small.validate(),
            Err(ConfigError::InvalidLimit("max_in_flight_bytes"))
        );
    }

    #[test]
    fn debug_output_never_contains_the_credential() {
        let rendered = format!("{:?}", config());
        assert!(!rendered.contains(&"c".repeat(32)), "{rendered}");
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn rejects_weak_credentials_and_zero_limits() {
        let mut weak = config();
        weak.upstream_credential = Some("short".into());
        assert_eq!(weak.validate(), Err(ConfigError::InvalidCredential));

        let mut zero = config();
        zero.limits.max_connections = 0;
        assert_eq!(
            zero.validate(),
            Err(ConfigError::InvalidLimit("max_connections"))
        );
    }
}
