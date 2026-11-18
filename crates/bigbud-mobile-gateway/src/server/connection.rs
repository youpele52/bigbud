//! One phone connection: hyper parses HTTP/1.1 with header-size and header
//! deadline limits, the route allowlist decides, and each request is served,
//! forwarded once, or upgraded. Connections do not persist between requests.

use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, header};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, watch};

use super::shared::{Shared, log_event};
use crate::assets;
use crate::body::{GatewayBody, status_response};
use crate::pairing::forward_pairing;
use crate::route::{Route, classify};
use crate::websocket::handle_websocket;

/// Upper bound for a non-upgraded connection, including slow asset downloads.
const HTTP_CONNECTION_DEADLINE: Duration = Duration::from_secs(120);
const REJECTION_DEADLINE: Duration = Duration::from_secs(2);

fn builder(shared: &Shared) -> http1::Builder {
    let limits = shared.config.limits;
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(limits.head_read_timeout)
        .max_buf_size(limits.max_head_bytes)
        .max_headers(64)
        // Keep-alive stays on only so a 101 carries a clean `Connection:
        // Upgrade`; every other response sets `Connection: close` (see
        // `dispatch`), so no connection serves a second request.
        .keep_alive(true)
        .half_close(false);
    builder
}

async fn dispatch(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    permit: Arc<OwnedSemaphorePermit>,
    shutdown: watch::Receiver<bool>,
) -> Response<GatewayBody> {
    let mut response = route_request(request, shared, permit, shutdown).await;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        response.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
    }
    response
}

async fn route_request(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    permit: Arc<OwnedSemaphorePermit>,
    shutdown: watch::Receiver<bool>,
) -> Response<GatewayBody> {
    let target = request
        .uri()
        .path_and_query()
        .map_or("", |value| value.as_str());
    // Absolute-form targets (`GET http://host/...`) fail `classify`'s leading-slash rule.
    let route = match classify(request.method().as_str(), target) {
        Ok(route) => route,
        Err(status) => {
            log_event("reject", &format!("route-{}", status.as_u16()));
            return status_response(status);
        }
    };
    if request.uri().authority().is_some() {
        return status_response(StatusCode::BAD_REQUEST);
    }
    let limits = shared.config.limits;
    match &route {
        Route::Asset {
            relative,
            head_only,
        } => {
            let root = shared.config.assets_dir.clone();
            assets::serve(root, relative.clone(), *head_only, limits.max_asset_bytes).await
        }
        Route::MobileWs => handle_websocket(request, shared, permit, shutdown).await,
        Route::PairingExchange { id } if !shared.pairing_limiter.try_acquire(id) => {
            log_event("reject", "pairing-rate-limit");
            status_response(StatusCode::TOO_MANY_REQUESTS)
        }
        Route::PairingExchange { .. }
        | Route::PairingStatus
        | Route::PairingPreflight
        | Route::MobileHandshake => forward_pairing(request, &route, &shared).await,
    }
}

pub async fn serve(
    stream: TcpStream,
    shared: Arc<Shared>,
    permit: OwnedSemaphorePermit,
    mut shutdown: watch::Receiver<bool>,
) {
    if stream.set_nodelay(true).is_err() {
        return;
    }
    // Shared with any WebSocket relay so an upgraded socket keeps its slot.
    let permit = Arc::new(permit);
    let service_shared = Arc::clone(&shared);
    let service_shutdown = shutdown.clone();
    let service = service_fn(move |request| {
        let shared = Arc::clone(&service_shared);
        let permit = Arc::clone(&permit);
        let shutdown = service_shutdown.clone();
        async move {
            Ok::<_, std::convert::Infallible>(dispatch(request, shared, permit, shutdown).await)
        }
    });
    let connection = builder(&shared)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::select! {
        result = tokio::time::timeout(HTTP_CONNECTION_DEADLINE, connection) => match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log_event("http-error", if error.is_parse() { "parse" } else { "io" }),
            Err(_) => log_event("http-deadline", "connection"),
        },
        _ = shutdown.changed() => {}
    }
}

/// Answers 503 for a connection over the budget, then closes it.
pub async fn reject_over_limit(stream: TcpStream, _permit: OwnedSemaphorePermit) {
    let service = service_fn(|_request: Request<Incoming>| async {
        Ok::<_, std::convert::Infallible>(status_response(StatusCode::SERVICE_UNAVAILABLE))
    });
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(REJECTION_DEADLINE)
        .keep_alive(false);
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    // Timeout is the expected outcome for clients that never send a request.
    let _finished = tokio::time::timeout(REJECTION_DEADLINE, connection).await;
}
