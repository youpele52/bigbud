//! Upgrade validation for both legs. The phone's request must be a complete
//! RFC 6455 upgrade; the backend leg uses a fresh key, and tungstenite rejects
//! a backend response without the matching `Sec-WebSocket-Accept`.

use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, StatusCode, Version};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::config::Limits;
use crate::headers::upstream_request_headers;
use crate::server::shared::{Shared, log_event};
use crate::upstream::{UpstreamStream, connect_upstream};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientUpgrade {
    pub key: String,
    pub protocols: Option<HeaderValue>,
}

pub struct BackendSocket {
    pub stream: WebSocketStream<UpstreamStream>,
    pub protocol: Option<HeaderValue>,
}

fn has_token(headers: &HeaderMap, name: header::HeaderName, token: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|item| item.trim().eq_ignore_ascii_case(token))
}

/// A Sec-WebSocket-Key is base64 of exactly 16 bytes: 22 symbols then `==`,
/// where the last symbol carries no extra bits.
fn is_valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let (Some(symbols), Some(padding)) = (bytes.get(..22), bytes.get(22..)) else {
        return false;
    };
    bytes.len() == 24
        && padding == b"=="
        && symbols
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && symbols.last().is_some_and(|last| b"AQgw".contains(last))
}

pub fn validate_client_upgrade(request: &Request<Incoming>) -> Result<ClientUpgrade, StatusCode> {
    validate_upgrade_parts(request.version(), request.headers())
}

pub(crate) fn validate_upgrade_parts(
    version: Version,
    headers: &HeaderMap,
) -> Result<ClientUpgrade, StatusCode> {
    if version != Version::HTTP_11
        || !has_token(headers, header::CONNECTION, "upgrade")
        // hyper would turn a 101 into `Connection: close`, breaking the upgrade.
        || has_token(headers, header::CONNECTION, "close")
        || !has_token(headers, header::UPGRADE, "websocket")
        || headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|value| value != "0")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut versions = headers.get_all(header::SEC_WEBSOCKET_VERSION).iter();
    if versions.next().is_none_or(|value| value != "13") || versions.next().is_some() {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }
    let mut keys = headers.get_all(header::SEC_WEBSOCKET_KEY).iter();
    let key = match (keys.next(), keys.next()) {
        (Some(value), None) => value.to_str().ok().filter(|key| is_valid_key(key)),
        _ => None,
    }
    .ok_or(StatusCode::BAD_REQUEST)?;
    Ok(ClientUpgrade {
        key: key.to_owned(),
        protocols: headers.get(header::SEC_WEBSOCKET_PROTOCOL).cloned(),
    })
}

/// The phone leg: 1 MiB inbound messages (fragments included); outbound
/// writes may buffer at most one outbound message plus the write buffer.
pub fn phone_config(limits: &Limits) -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(limits.max_inbound_ws_message_bytes))
        .max_frame_size(Some(limits.max_inbound_ws_message_bytes))
        .write_buffer_size(limits.ws_write_buffer_bytes)
        .max_write_buffer_size(limits.max_outbound_ws_message_bytes + limits.ws_write_buffer_bytes)
}

fn backend_config(limits: &Limits) -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(limits.max_outbound_ws_message_bytes))
        .max_frame_size(Some(limits.max_outbound_ws_message_bytes))
        .write_buffer_size(limits.ws_write_buffer_bytes)
        .max_write_buffer_size(limits.max_inbound_ws_message_bytes + limits.ws_write_buffer_bytes)
}

/// Opens the backend WebSocket. Non-101 answers (for example 401 for a revoked
/// token) are relayed as that status; malformed answers become 502.
pub async fn connect_backend(
    target: &str,
    request: &Request<Incoming>,
    client: &ClientUpgrade,
    shared: &Shared,
) -> Result<BackendSocket, StatusCode> {
    let limits = shared.config.limits;
    let context = shared.forward_context();
    let mut headers = upstream_request_headers(request.headers(), &context)
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(
        header::SEC_WEBSOCKET_VERSION,
        HeaderValue::from_static("13"),
    );
    let key =
        HeaderValue::from_str(&generate_key()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    headers.insert(header::SEC_WEBSOCKET_KEY, key);
    if let Some(protocols) = &client.protocols {
        headers.insert(header::SEC_WEBSOCKET_PROTOCOL, protocols.clone());
    }
    let uri = format!("ws://{}{target}", context.external_host);
    let mut upstream_request = Request::new(());
    *upstream_request.uri_mut() = uri.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    *upstream_request.headers_mut() = headers;

    let stream = connect_upstream(&shared.config.upstream, limits.upstream_connect_timeout)
        .await
        .map_err(|error| {
            log_event("upstream-unavailable", &error.kind().to_string());
            StatusCode::BAD_GATEWAY
        })?;
    let handshake = tokio_tungstenite::client_async_with_config(
        upstream_request,
        stream,
        Some(backend_config(&limits)),
    );
    let (socket, response) = match tokio::time::timeout(limits.head_read_timeout, handshake).await {
        Err(_) => return Err(StatusCode::GATEWAY_TIMEOUT),
        Ok(Err(WsError::Http(response))) => {
            let status = response.status();
            log_event("upgrade-rejected", status.as_str());
            return Err(if status.is_client_error() {
                status
            } else {
                StatusCode::BAD_GATEWAY
            });
        }
        Ok(Err(_)) => {
            log_event("upstream-handshake-invalid", "accept-or-headers");
            return Err(StatusCode::BAD_GATEWAY);
        }
        Ok(Ok(pair)) => pair,
    };
    // No extensions were offered, so any negotiated extension is a protocol error.
    if response
        .headers()
        .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    {
        log_event("upstream-handshake-invalid", "unrequested-extension");
        return Err(StatusCode::BAD_GATEWAY);
    }
    Ok(BackendSocket {
        stream: socket,
        protocol: response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_static(value));
        }
        map
    }

    const GOOD: &[(&str, &str)] = &[
        ("connection", "keep-alive, Upgrade"),
        ("upgrade", "websocket"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
    ];

    #[test]
    fn accepts_a_complete_upgrade() {
        let upgrade = validate_upgrade_parts(Version::HTTP_11, &headers(GOOD)).unwrap();
        assert_eq!(upgrade.key, "dGhlIHNhbXBsZSBub25jZQ==");
    }

    #[test]
    fn rejects_incomplete_or_malformed_upgrades() {
        let without = |skip: &str| {
            let pairs: Vec<_> = GOOD
                .iter()
                .copied()
                .filter(|(name, _)| *name != skip)
                .collect();
            validate_upgrade_parts(Version::HTTP_11, &headers(&pairs))
        };
        assert_eq!(without("connection"), Err(StatusCode::BAD_REQUEST));
        assert_eq!(without("upgrade"), Err(StatusCode::BAD_REQUEST));
        assert_eq!(
            without("sec-websocket-version"),
            Err(StatusCode::UPGRADE_REQUIRED)
        );
        assert_eq!(without("sec-websocket-key"), Err(StatusCode::BAD_REQUEST));
        assert_eq!(
            validate_upgrade_parts(Version::HTTP_10, &headers(GOOD)),
            Err(StatusCode::BAD_REQUEST)
        );

        let mut wrong_version = headers(GOOD);
        wrong_version.insert("sec-websocket-version", HeaderValue::from_static("8"));
        assert_eq!(
            validate_upgrade_parts(Version::HTTP_11, &wrong_version),
            Err(StatusCode::UPGRADE_REQUIRED)
        );

        for bad_key in [
            "short",
            "dGhlIHNhbXBsZSBub25jZR==",
            "dGhlIHNhbXBsZSBub25jZQ=",
            "dGhl!HNhbXBsZSBub25jZQ==",
        ] {
            let mut map = headers(GOOD);
            map.insert("sec-websocket-key", HeaderValue::from_static(bad_key));
            assert_eq!(
                validate_upgrade_parts(Version::HTTP_11, &map),
                Err(StatusCode::BAD_REQUEST),
                "{bad_key}"
            );
        }
        let mut two_keys = headers(GOOD);
        two_keys.append(
            "sec-websocket-key",
            HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
        );
        assert_eq!(
            validate_upgrade_parts(Version::HTTP_11, &two_keys),
            Err(StatusCode::BAD_REQUEST)
        );

        let mut closing = headers(GOOD);
        closing.insert("connection", HeaderValue::from_static("close, Upgrade"));
        assert_eq!(
            validate_upgrade_parts(Version::HTTP_11, &closing),
            Err(StatusCode::BAD_REQUEST)
        );

        let mut with_body = headers(GOOD);
        with_body.insert("content-length", HeaderValue::from_static("5"));
        assert_eq!(
            validate_upgrade_parts(Version::HTTP_11, &with_body),
            Err(StatusCode::BAD_REQUEST)
        );
    }
}
