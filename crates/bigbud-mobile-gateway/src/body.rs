//! Response body type and small fixed responses written by the gateway.

use std::io;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{Response, StatusCode, header};

pub type GatewayBody = BoxBody<Bytes, io::Error>;

pub fn full(bytes: impl Into<Bytes>) -> GatewayBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

pub fn empty() -> GatewayBody {
    full(Bytes::new())
}

/// A plain-text response for gateway-originated errors. The connection closes
/// afterwards so a rejected request never shares a socket with a later one.
pub fn status_response(status: StatusCode) -> Response<GatewayBody> {
    let reason = status.canonical_reason().unwrap_or("Error");
    let mut response = Response::new(full(reason.to_owned()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("close"),
    );
    if matches!(
        status,
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS
    ) {
        headers.insert(header::RETRY_AFTER, header::HeaderValue::from_static("2"));
    }
    response
}
