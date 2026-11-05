use crate::guard::record::valid_id;

/// Platform identity from the trusted human/OS inventory (bundle ID, AUMID,
/// desktop-entry ID). Labels are presentation only. No public constructor:
/// a model-supplied name must resolve through the inventory first.
/// ```compile_fail
/// let app = bigbud_computer_use::broker::AppIdentity { id: "x".into() };
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    id: String,
}
impl AppIdentity {
    pub fn id(&self) -> &str {
        &self.id
    }
    /// Only the (future) trusted inventory resolver may call this; that
    /// resolver (installed/running app enumeration) is not implemented yet.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn from_trusted_inventory(id: &str) -> Option<Self> {
        valid_id(id).then(|| Self { id: id.into() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    Scheme,
    Credentials,
    Host,
    Length,
    Characters,
}

/// Absolute http(s) URL without userinfo or control/whitespace characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpUrl(String);
impl HttpUrl {
    pub const MAX_LENGTH: usize = 2048;
    pub fn parse(text: &str) -> Result<Self, UrlError> {
        if text.len() > Self::MAX_LENGTH {
            return Err(UrlError::Length);
        }
        if !text.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(UrlError::Characters);
        }
        let lower = text
            .get(..8)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let rest = if lower.starts_with("https://") {
            text.get(8..)
        } else if lower.starts_with("http://") {
            text.get(7..)
        } else {
            None
        }
        .ok_or(UrlError::Scheme)?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.contains('@') {
            return Err(UrlError::Credentials);
        }
        let host = authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host);
        if host.is_empty() {
            return Err(UrlError::Host);
        }
        Ok(Self(text.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerRequest {
    /// Explicit `background` requests no activation; self-activation by the app
    /// is a reported delivery violation, never fought by a watchdog/replay.
    LaunchApp { app: AppIdentity, background: bool },
    /// Handler must be the exact checked HTTP(S) handler; never open.default.
    OpenUrl {
        handler: AppIdentity,
        url: HttpUrl,
        background: bool,
    },
}
