//! The complete allowlist of what the gateway accepts. Anything not matched
//! here is rejected before an upstream connection is opened; in particular
//! the full `/ws` RPC, provider callbacks and arbitrary backend routes.

use hyper::StatusCode as Status;

const PAIRING_PREFIX: &str = "/api/mobile/pairing/";
const EXCHANGE_SUFFIX: &str = "/exchange";
const MOBILE_HANDSHAKE_PATH: &str = "/api/mobile/handshake";
const MOBILE_WS_PATH: &str = "/mobile-ws";
const MOBILE_ASSET_ROOT: &str = "/mobile";
const MAX_PAIRING_ID_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Served by the gateway from its assets directory. `relative` has no leading slash.
    Asset {
        relative: String,
        head_only: bool,
    },
    PairingStatus,
    /// Public-safe descriptor relayed from the owning backend without interpreting it.
    MobileHandshake,
    /// `id` is the validated pairing ID; exchange attempts are limited per ID.
    PairingExchange {
        id: String,
    },
    PairingPreflight,
    MobileWs,
}

impl Route {
    /// Routes the gateway forwards to the TypeScript backend.
    pub fn is_forwarded(&self) -> bool {
        !matches!(self, Self::Asset { .. })
    }
}

fn is_safe_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    path.starts_with('/')
        && path.is_ascii()
        && !path.contains(['\\', '\0'])
        && !path.contains("//")
        && !["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|encoded| lowered.contains(encoded))
        && path
            .split('/')
            .skip(1)
            .all(|segment| segment != "." && segment != "..")
}

fn is_pairing_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PAIRING_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn classify_pairing(method: &str, rest: &str, has_query: bool) -> Result<Route, Status> {
    if has_query {
        return Err(Status::BAD_REQUEST);
    }
    let (id, exchange) = match rest.strip_suffix(EXCHANGE_SUFFIX) {
        Some(id) => (id, true),
        None => (rest, false),
    };
    if !is_pairing_id(id) {
        return Err(Status::NOT_FOUND);
    }
    match (method, exchange) {
        ("OPTIONS", _) => Ok(Route::PairingPreflight),
        ("GET", false) => Ok(Route::PairingStatus),
        ("POST", true) => Ok(Route::PairingExchange { id: id.to_owned() }),
        _ => Err(Status::METHOD_NOT_ALLOWED),
    }
}

fn classify_asset(method: &str, path: &str) -> Result<Route, Status> {
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Err(Status::METHOD_NOT_ALLOWED),
    };
    let relative = path
        .strip_prefix(MOBILE_ASSET_ROOT)
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or_default();
    Ok(Route::Asset {
        relative: relative.to_owned(),
        head_only,
    })
}

/// Classifies an origin-form request target.
pub fn classify(method: &str, target: &str) -> Result<Route, Status> {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };
    if !is_safe_path(path) || query.is_some_and(|query| query.contains('#')) {
        return Err(Status::BAD_REQUEST);
    }
    if let Some(rest) = path.strip_prefix(PAIRING_PREFIX) {
        return classify_pairing(method, rest, query.is_some());
    }
    if path == MOBILE_HANDSHAKE_PATH {
        if query.is_some() {
            return Err(Status::BAD_REQUEST);
        }
        return if method == "GET" {
            Ok(Route::MobileHandshake)
        } else {
            Err(Status::METHOD_NOT_ALLOWED)
        };
    }
    if path == MOBILE_WS_PATH {
        return if method == "GET" {
            Ok(Route::MobileWs)
        } else {
            Err(Status::METHOD_NOT_ALLOWED)
        };
    }
    if path == MOBILE_ASSET_ROOT || path.starts_with("/mobile/") {
        return classify_asset(method, path);
    }
    Err(Status::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_mobile_routes() {
        assert_eq!(
            classify("GET", "/api/mobile/pairing/abc_1"),
            Ok(Route::PairingStatus)
        );
        assert_eq!(
            classify("POST", "/api/mobile/pairing/abc/exchange"),
            Ok(Route::PairingExchange {
                id: "abc".to_owned()
            })
        );
        assert_eq!(
            classify("OPTIONS", "/api/mobile/pairing/abc/exchange"),
            Ok(Route::PairingPreflight)
        );
        assert_eq!(classify("GET", "/mobile-ws?token=t"), Ok(Route::MobileWs));
        assert_eq!(
            classify("GET", "/mobile/pair/abc?backend=x"),
            Ok(Route::Asset {
                relative: "pair/abc".into(),
                head_only: false
            })
        );
        assert_eq!(
            classify("HEAD", "/mobile"),
            Ok(Route::Asset {
                relative: String::new(),
                head_only: true
            })
        );
    }

    #[test]
    fn descriptor_is_get_only_and_has_no_query_or_subroutes() {
        assert_eq!(
            classify("GET", "/api/mobile/handshake"),
            Ok(Route::MobileHandshake)
        );
        for method in ["HEAD", "POST", "PUT", "OPTIONS"] {
            assert_eq!(
                classify(method, "/api/mobile/handshake"),
                Err(Status::METHOD_NOT_ALLOWED)
            );
        }
        for target in ["/api/mobile/handshake?", "/api/mobile/handshake?token=x"] {
            assert_eq!(classify("GET", target), Err(Status::BAD_REQUEST));
        }
        assert_eq!(
            classify("GET", "/api/mobile/handshake/other"),
            Err(Status::NOT_FOUND)
        );
    }

    #[test]
    fn rejects_full_rpc_and_unlisted_routes() {
        for target in [
            "/ws",
            "/ws?token=x",
            "/",
            "/api/projects",
            "/api/mobile/sessions",
            "/mobilex",
        ] {
            assert_eq!(classify("GET", target), Err(Status::NOT_FOUND), "{target}");
        }
        assert_eq!(
            classify("POST", "/mobile-ws"),
            Err(Status::METHOD_NOT_ALLOWED)
        );
        assert_eq!(
            classify("DELETE", "/mobile/index.html"),
            Err(Status::METHOD_NOT_ALLOWED)
        );
        assert_eq!(
            classify("GET", "/api/mobile/pairing/abc/exchange"),
            Err(Status::METHOD_NOT_ALLOWED)
        );
        assert_eq!(
            classify("POST", "/api/mobile/pairing/abc"),
            Err(Status::METHOD_NOT_ALLOWED)
        );
    }

    #[test]
    fn rejects_traversal_encoding_and_odd_targets() {
        for target in [
            "/mobile/../ws",
            "/mobile/%2e%2e/ws",
            "/mobile/a%2Fb",
            "/mobile//x",
            "/mobile/a\\b",
            "http://evil/ws",
            "*",
            "/api/mobile/pairing/abc?x=1",
        ] {
            assert!(classify("GET", target).is_err(), "{target}");
        }
        assert_eq!(
            classify("GET", "/api/mobile/pairing/a.b"),
            Err(Status::NOT_FOUND)
        );
        assert_eq!(
            classify("GET", "/api/mobile/pairing/"),
            Err(Status::NOT_FOUND)
        );
    }
}
