//! Forwards one pairing request (status, exchange or CORS preflight) to the
//! fixed upstream. Bodies are bounded in both directions, the whole exchange
//! has one deadline, and nothing is retried: a failure is reported, never
//! replayed.

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::{Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;

use crate::body::{GatewayBody, full, status_response};
use crate::headers::{strip_hop_by_hop_response_headers, upstream_request_headers};
use crate::route::Route;
use crate::server::shared::{Shared, log_event};
use crate::upstream::connect_upstream;

/// Tokio JoinHandle drop detaches. Keep abort authority in the exchange future so
/// timeout, cancellation, error and success all retire its one connection driver.
struct AbortDriverOnDrop(tokio::task::AbortHandle);

impl Drop for AbortDriverOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Request framing rules, checked before any upstream connection.
fn check_framing(request: &Request<Incoming>, route: &Route, max: usize) -> Result<(), StatusCode> {
    let headers = request.headers();
    if headers.contains_key(header::TRANSFER_ENCODING) {
        // Mobile web never streams uploads; refusing chunked bodies keeps
        // framing unambiguous end to end.
        return Err(StatusCode::NOT_IMPLEMENTED);
    }
    let length = match headers.get(header::CONTENT_LENGTH) {
        None => None,
        Some(value) => Some(
            value
                .to_str()
                .ok()
                .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|text| text.parse::<usize>().ok())
                .ok_or(StatusCode::BAD_REQUEST)?,
        ),
    };
    match (route, length) {
        (Route::PairingExchange { .. }, None) => Err(StatusCode::LENGTH_REQUIRED),
        (_, Some(length)) if length > max => Err(StatusCode::PAYLOAD_TOO_LARGE),
        (Route::PairingExchange { .. }, Some(_)) | (_, None | Some(0)) => Ok(()),
        (_, Some(_)) => Err(StatusCode::BAD_REQUEST),
    }
}

pub async fn forward_pairing(
    request: Request<Incoming>,
    route: &Route,
    shared: &Shared,
) -> Response<GatewayBody> {
    let limits = shared.config.limits;
    if let Err(status) = check_framing(&request, route, limits.max_request_body_bytes) {
        return status_response(status);
    }
    let (parts, body) = request.into_parts();
    let collected = tokio::time::timeout(
        limits.head_read_timeout,
        Limited::new(body, limits.max_request_body_bytes).collect(),
    )
    .await;
    let body = match collected {
        Ok(Ok(collected)) => collected.to_bytes(),
        Ok(Err(_)) => return status_response(StatusCode::BAD_REQUEST),
        Err(_) => return status_response(StatusCode::REQUEST_TIMEOUT),
    };
    let Some(headers) = upstream_request_headers(&parts.headers, &shared.forward_context()) else {
        return status_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |value| value.as_str());
    let mut upstream_request = Request::new(Full::new(body));
    *upstream_request.method_mut() = parts.method;
    *upstream_request.headers_mut() = headers;
    match path.parse() {
        Ok(uri) => *upstream_request.uri_mut() = uri,
        Err(_) => return status_response(StatusCode::BAD_REQUEST),
    }
    match tokio::time::timeout(
        limits.upstream_request_timeout,
        exchange(upstream_request, shared),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(status)) => status_response(status),
        Err(_) => {
            log_event("upstream-timeout", "pairing");
            status_response(StatusCode::GATEWAY_TIMEOUT)
        }
    }
}

async fn exchange(
    request: Request<Full<bytes::Bytes>>,
    shared: &Shared,
) -> Result<Response<GatewayBody>, StatusCode> {
    let limits = shared.config.limits;
    let stream = connect_upstream(&shared.config.upstream, limits.upstream_connect_timeout)
        .await
        .map_err(|error| {
            log_event("upstream-unavailable", &error.kind().to_string());
            StatusCode::BAD_GATEWAY
        })?;
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let driver = tokio::spawn(connection);
    let _abort_driver = AbortDriverOnDrop(driver.abort_handle());
    let result = async {
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let (mut parts, body) = response.into_parts();
        let body = Limited::new(body, limits.max_upstream_response_bytes)
            .collect()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .to_bytes();
        strip_hop_by_hop_response_headers(&mut parts.headers);
        Ok(Response::from_parts(parts, full(body)))
    }
    .await;
    // The scope guard also aborts if the outer deadline drops this future.
    result
}
