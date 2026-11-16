//! Header hygiene for both legs. Upstream requests are rebuilt from an
//! allowlist, so client-supplied forwarding, identity, cookie and hop-by-hop
//! headers never reach the backend; the gateway states the external origin
//! itself. Responses from the backend lose hop-by-hop headers before relay.

use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};

/// Request headers copied to the backend. Everything else is dropped,
/// including `cookie`, `authorization`, `forwarded`, `x-forwarded-*`,
/// `x-real-ip`, `tailscale-*`, `te`, `trailer` and `upgrade`/`connection`.
const ALLOWED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "access-control-request-headers",
    "access-control-request-method",
    "cache-control",
    "content-type",
    "origin",
    "pragma",
    "user-agent",
];

/// Hop-by-hop response headers (RFC 9110 §7.6.1) plus framing hyper recomputes.
const HOP_BY_HOP_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

pub const GATEWAY_CREDENTIAL_HEADER: &str = "x-bigbud-mobile-gateway";

pub struct ForwardContext<'a> {
    pub external_host: &'a str,
    pub credential: Option<&'a str>,
}

/// Builds the backend request headers. Returns None if a configured value is
/// not a valid header value (configuration validation prevents this).
pub fn upstream_request_headers(
    client: &HeaderMap,
    context: &ForwardContext<'_>,
) -> Option<HeaderMap> {
    let mut headers = HeaderMap::new();
    for name in ALLOWED_REQUEST_HEADERS {
        for value in client.get_all(*name) {
            headers.append(HeaderName::from_static(name), value.clone());
        }
    }
    headers.insert(
        header::HOST,
        HeaderValue::from_str(context.external_host).ok()?,
    );
    headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("https"),
    );
    headers.insert(
        HeaderName::from_static("x-forwarded-host"),
        HeaderValue::from_str(context.external_host).ok()?,
    );
    if let Some(credential) = context.credential {
        let mut value = HeaderValue::from_str(credential).ok()?;
        value.set_sensitive(true);
        headers.insert(HeaderName::from_static(GATEWAY_CREDENTIAL_HEADER), value);
    }
    Some(headers)
}

pub fn strip_hop_by_hop_response_headers(headers: &mut HeaderMap) {
    // Headers named by `Connection` are hop-by-hop too.
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP_RESPONSE_HEADERS {
        headers.remove(*name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilds_request_headers_from_the_allowlist() {
        let mut client = HeaderMap::new();
        for (name, value) in [
            ("host", "evil.example"),
            ("x-forwarded-proto", "http"),
            ("x-forwarded-for", "6.6.6.6"),
            ("forwarded", "for=6.6.6.6"),
            ("tailscale-user-login", "mallory"),
            ("cookie", "a=b"),
            ("authorization", "Bearer x"),
            ("x-bigbud-mobile-gateway", "forged"),
            ("te", "trailers"),
            ("origin", "https://desk.ts.net"),
            ("content-type", "application/json"),
        ] {
            client.append(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        let credential = "c".repeat(32);
        let context = ForwardContext {
            external_host: "desk.ts.net",
            credential: Some(&credential),
        };
        let built = upstream_request_headers(&client, &context).unwrap();
        assert_eq!(built.get("host").unwrap(), "desk.ts.net");
        assert_eq!(built.get("x-forwarded-proto").unwrap(), "https");
        assert_eq!(
            built.get(GATEWAY_CREDENTIAL_HEADER).unwrap(),
            credential.as_str()
        );
        assert_eq!(built.get("origin").unwrap(), "https://desk.ts.net");
        for dropped in [
            "x-forwarded-for",
            "forwarded",
            "tailscale-user-login",
            "cookie",
            "authorization",
            "te",
        ] {
            assert!(built.get(dropped).is_none(), "{dropped}");
        }
    }

    #[test]
    fn strips_hop_by_hop_and_connection_named_response_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("close, x-secret-hop"),
        );
        headers.insert(
            HeaderName::from_static("x-secret-hop"),
            HeaderValue::from_static("1"),
        );
        headers.insert(
            header::TRANSFER_ENCODING,
            HeaderValue::from_static("chunked"),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        strip_hop_by_hop_response_headers(&mut headers);
        assert!(
            headers.get("x-secret-hop").is_none() && headers.get("transfer-encoding").is_none()
        );
        assert!(headers.get(header::CONTENT_TYPE).is_some());
    }
}
