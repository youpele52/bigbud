//! Strict decoder for the frozen canonical policy encoding shared with
//! TypeScript (`@bigbud/shared/computer-use/policy.canonical`, golden vectors
//! in `protocol/computer-use/policy.v1.golden`). Only bytes that re-encode
//! identically are accepted: fixed field order, canonical decimals, selectors
//! strictly increasing by UTF-8 bytes (so no duplicates), no blank or extra
//! lines. The digest is recomputed (portable `sha2`) before any
//! acknowledgement on every target.
use super::{
    limits::{MAX_ACTION_TIMEOUT, MAX_CHECK_IN, MIN_ACTION_TIMEOUT, MIN_CHECK_IN},
    policy::{MAX_CANONICAL_POLICY_BYTES, parse_revision},
};
use crate::guard::record::valid_id;
use std::time::Duration;

pub const POLICY_FORMAT: &str = "bigbud.computerUsePolicy.v1";
/// The frozen engineering bounds in `limits.rs` (also the settings ranges).
const CHECK_IN: (Duration, Duration) = (MIN_CHECK_IN, MAX_CHECK_IN);
const ACTION_TIMEOUT: (Duration, Duration) = (MIN_ACTION_TIMEOUT, MAX_ACTION_TIMEOUT);
const SELECTOR_KINDS: [(&str, &[&str]); 3] = [
    ("macos", &["bundle_id", "code_requirement", "path"]),
    ("windows", &["aumid", "package_family", "executable"]),
    ("linux", &["desktop_entry", "executable"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalRefusal {
    Oversized,
    Malformed,
    OutOfRange,
    UnsortedOrDuplicate,
    DigestMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Foreground,
    Background,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSelector {
    pub platform: String,
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalPolicy {
    pub authority: String,
    pub revision: u64,
    pub enabled: bool,
    pub delivery: Delivery,
    pub check_in_ms: u64,
    pub action_timeout_ms: u64,
    pub diagnostics: bool,
    pub disallowed: Vec<AppSelector>,
}

struct Lines<'a>(std::str::Split<'a, char>);
impl<'a> Lines<'a> {
    fn field(&mut self, key: &str) -> Result<&'a str, CanonicalRefusal> {
        self.0
            .next()
            .and_then(|line| line.strip_prefix(key))
            .and_then(|rest| rest.strip_prefix('='))
            .ok_or(CanonicalRefusal::Malformed)
    }
}

fn flag(text: &str) -> Result<bool, CanonicalRefusal> {
    match text {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(CanonicalRefusal::Malformed),
    }
}

fn bounded(text: &str, (min, max): (Duration, Duration)) -> Result<u64, CanonicalRefusal> {
    let value = parse_revision(text).ok_or(CanonicalRefusal::Malformed)?;
    let duration = Duration::from_millis(value);
    (min <= duration && duration <= max)
        .then_some(value)
        .ok_or(CanonicalRefusal::OutOfRange)
}

/// Exactly TypeScript's framing set: C0 controls and DEL (not C1).
fn framing_control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}')
}

fn selector(line: &str) -> Result<AppSelector, CanonicalRefusal> {
    let key = line
        .strip_prefix("app=")
        .ok_or(CanonicalRefusal::Malformed)?;
    let mut parts = key.splitn(3, '\t');
    let (Some(platform), Some(kind), Some(value)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(CanonicalRefusal::Malformed);
    };
    let known = SELECTOR_KINDS
        .iter()
        .any(|(name, kinds)| *name == platform && kinds.contains(&kind));
    if !known || value.is_empty() || value.chars().any(framing_control) {
        return Err(CanonicalRefusal::Malformed);
    }
    Ok(AppSelector {
        platform: platform.into(),
        kind: kind.into(),
        value: value.into(),
    })
}

impl CanonicalPolicy {
    pub fn decode(bytes: &[u8]) -> Result<Self, CanonicalRefusal> {
        if bytes.is_empty() || bytes.len() > MAX_CANONICAL_POLICY_BYTES {
            return Err(CanonicalRefusal::Oversized);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| CanonicalRefusal::Malformed)?;
        let body = text.strip_suffix('\n').ok_or(CanonicalRefusal::Malformed)?;
        let mut lines = Lines(body.split('\n'));
        if lines.0.next() != Some(POLICY_FORMAT) {
            return Err(CanonicalRefusal::Malformed);
        }
        let authority = lines.field("authority")?;
        if !valid_id(authority) {
            return Err(CanonicalRefusal::Malformed);
        }
        let revision =
            parse_revision(lines.field("revision")?).ok_or(CanonicalRefusal::Malformed)?;
        let enabled = flag(lines.field("enabled")?)?;
        let delivery = match lines.field("delivery")? {
            "foreground" => Delivery::Foreground,
            "background" => Delivery::Background,
            _ => return Err(CanonicalRefusal::Malformed),
        };
        let check_in_ms = bounded(lines.field("check_in_ms")?, CHECK_IN)?;
        let action_timeout_ms = bounded(lines.field("action_timeout_ms")?, ACTION_TIMEOUT)?;
        let diagnostics = flag(lines.field("diagnostics")?)?;
        let count =
            parse_revision(lines.field("disallowed")?).ok_or(CanonicalRefusal::Malformed)?;
        let mut disallowed = Vec::new();
        let mut previous: Option<&str> = None;
        for line in lines.0 {
            if u64::try_from(disallowed.len()).map_or(true, |seen| seen >= count) {
                return Err(CanonicalRefusal::Malformed);
            }
            disallowed.push(selector(line)?);
            if previous.is_some_and(|prior| prior.as_bytes() >= line.as_bytes()) {
                return Err(CanonicalRefusal::UnsortedOrDuplicate);
            }
            previous = Some(line);
        }
        if u64::try_from(disallowed.len()).ok() != Some(count) {
            return Err(CanonicalRefusal::Malformed);
        }
        let policy = Self {
            authority: authority.into(),
            revision,
            enabled,
            delivery,
            check_in_ms,
            action_timeout_ms,
            diagnostics,
            disallowed,
        };
        // Belt and braces: the accepted form is exactly the canonical form.
        if policy.encode() != bytes {
            return Err(CanonicalRefusal::Malformed);
        }
        Ok(policy)
    }

    pub fn encode(&self) -> Vec<u8> {
        let delivery = match self.delivery {
            Delivery::Foreground => "foreground",
            Delivery::Background => "background",
        };
        let mut text = format!(
            "{POLICY_FORMAT}\nauthority={}\nrevision={}\nenabled={}\ndelivery={delivery}\n\
             check_in_ms={}\naction_timeout_ms={}\ndiagnostics={}\ndisallowed={}\n",
            self.authority,
            self.revision,
            u8::from(self.enabled),
            self.check_in_ms,
            self.action_timeout_ms,
            u8::from(self.diagnostics),
            self.disallowed.len(),
        );
        for app in &self.disallowed {
            text.push_str(&format!(
                "app={}\t{}\t{}\n",
                app.platform, app.kind, app.value
            ));
        }
        text.into_bytes()
    }

    /// Decodes, then recomputes and compares the digest.
    pub fn verify(bytes: &[u8], digest: [u8; 32]) -> Result<Self, CanonicalRefusal> {
        let policy = Self::decode(bytes)?;
        if crate::sha256::sha256(bytes) != digest {
            return Err(CanonicalRefusal::DigestMismatch);
        }
        Ok(policy)
    }
}
