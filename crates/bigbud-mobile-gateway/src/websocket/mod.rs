//! `/mobile-ws`: validate the phone's upgrade, complete a validated upgrade
//! with the backend first (so authorization failures are relayed as plain
//! HTTP), then relay opaque WebSocket messages with bounded buffers.

mod handshake;
mod relay;

pub use handshake::{ClientUpgrade, validate_client_upgrade};
pub use relay::relay;

use std::sync::Arc;

use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::sync::{OwnedSemaphorePermit, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;

use crate::body::{GatewayBody, empty, status_response};
use crate::server::shared::{Shared, log_event};

pub async fn handle_websocket(
    mut request: Request<Incoming>,
    shared: Arc<Shared>,
    permit: Arc<OwnedSemaphorePermit>,
    shutdown: watch::Receiver<bool>,
) -> Response<GatewayBody> {
    let client = match validate_client_upgrade(&request) {
        Ok(client) => client,
        Err(status) => {
            let mut response = status_response(status);
            if status == StatusCode::UPGRADE_REQUIRED {
                response.headers_mut().insert(
                    header::SEC_WEBSOCKET_VERSION,
                    HeaderValue::from_static("13"),
                );
            }
            return response;
        }
    };
    let target = request
        .uri()
        .path_and_query()
        .map_or("/mobile-ws", |value| value.as_str())
        .to_owned();
    let upstream = match handshake::connect_backend(&target, &request, &client, &shared).await {
        Ok(upstream) => upstream,
        Err(status) => return status_response(status),
    };
    let on_upgrade = hyper::upgrade::on(&mut request);
    let mut response = Response::new(empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = response.headers_mut();
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    let Ok(accept) = HeaderValue::from_str(&derive_accept_key(client.key.as_bytes())) else {
        return status_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    headers.insert(header::SEC_WEBSOCKET_ACCEPT, accept);
    if let Some(protocol) = upstream.protocol.clone() {
        headers.insert(header::SEC_WEBSOCKET_PROTOCOL, protocol);
    }
    let limits = shared.config.limits;
    let in_flight = Arc::clone(&shared.in_flight_bytes);
    tokio::spawn(async move {
        // Holding the permit keeps this relay inside the connection budget.
        let _permit = permit;
        let upgraded = match on_upgrade.await {
            Ok(upgraded) => upgraded,
            Err(_) => {
                log_event("client-upgrade-failed", "upgrade");
                return;
            }
        };
        let phone = WebSocketStream::from_raw_socket(
            TokioIo::new(upgraded),
            Role::Server,
            Some(handshake::phone_config(&limits)),
        )
        .await;
        let end = relay(phone, upstream.stream, &limits, &in_flight, shutdown).await;
        log_event("websocket-closed", end);
    });
    response
}
