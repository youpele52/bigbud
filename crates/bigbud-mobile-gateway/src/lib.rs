//! Narrow mobile gateway: the only bigbud surface Tailscale Serve exposes.
//!
//! The gateway serves mobile web assets and forwards exactly three request
//! families to the owning TypeScript backend: pairing status/exchange,
//! pairing CORS preflight, and the `/mobile-ws` WebSocket. HTTP and WebSocket
//! protocol handling come from hyper and tungstenite; WebSocket messages are
//! relayed opaquely and RPC payloads are never decoded. The gateway never
//! retries requests and holds no durable state: pairing authorization,
//! command receipts and conversation storage stay in TypeScript.

pub mod assets;
pub mod body;
pub mod cli;
pub mod config;
pub mod headers;
pub mod pairing;
pub mod rate_limit;
pub mod route;
pub mod server;
pub mod upstream;
pub mod websocket;

pub use config::{ConfigError, ExternalOrigin, GatewayConfig, Limits, Upstream};
pub use server::{Gateway, GatewayError, ShutdownHandle};
