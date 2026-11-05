//! Content-free projections of action results and metadata-only tools.
//! Action outcomes keep only the closed `ActionResult` enums (pinned 0.38
//! output schema) and a bounded error code; any doubt means "completion
//! unknown", never "not started". Summaries, hints, next calls, evidence
//! details, refusal messages and permission/health prose are dropped.
use super::egress::{EgressRefusal, Projection, boolean};
use super::response::ToolResponse;
use serde_json::{Map, Value};

const EFFECTS: &[&str] = &[
    "confirmed",
    "partial",
    "unverifiable",
    "suspected_noop",
    "refused",
];
const ROUTES: &[&str] = &[
    "accessibility",
    "synthetic_events",
    "global_input",
    "system_api",
    "dom",
    "trusted_input",
];
const DELIVERY_MODES: &[&str] = &["background", "foreground", "not_applicable", "unknown"];
const ESCALATION_TARGETS: &[&str] = &["pixel", "foreground", "page", "session"];
const ESCALATION_REASONS: &[&str] = &[
    "route_unavailable",
    "delivery_failed",
    "effect_unconfirmed",
    "suspected_noop",
    "permission_required",
];
const EVIDENCE_KINDS: &[&str] = &["value_readback", "window_change"];
/// The pinned `ActionResult` is closed (`additionalProperties: false`).
const ACTION_RESULT_KEYS: &[&str] = &[
    "effect",
    "route",
    "delivery",
    "error",
    "escalation",
    "evidence",
    "summary",
    "hint",
    "next_call",
];
const HEALTH_OVERALL: &[&str] = &["ok", "degraded", "failed"];
const HEALTH_STATUS: &[&str] = &["pass", "fail", "skip"];
const MAX_HEALTH_CHECKS: usize = 32;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionView {
    /// `None`: no trustworthy result, so completion is unknown.
    pub effect: Option<&'static str>,
    pub route: Option<&'static str>,
    pub delivery_mode: Option<&'static str>,
    pub delivered_count: Option<u64>,
    pub error_code: Option<String>,
    pub escalation: Option<(&'static str, &'static str)>,
    pub evidence: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthView {
    pub overall: &'static str,
    pub checks: Vec<(String, &'static str)>,
}

fn pick(value: Option<&Value>, allowed: &'static [&'static str]) -> Option<&'static str> {
    let text = value?.as_str()?;
    allowed.iter().copied().find(|candidate| *candidate == text)
}

/// A bounded machine identifier; anything else is dropped as prose.
fn ident(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let mut bytes = text.bytes();
    let valid = text.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then(|| text.to_owned())
}

fn optional<T>(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(value) => parse(value).map(Some),
    }
}

pub(super) fn action(response: Option<ToolResponse>) -> ActionView {
    let Some((is_error, structured)) =
        response.and_then(|response| Some((response.is_error, response.structured?)))
    else {
        return ActionView::default();
    };
    if structured.contains_key("effect") {
        // Any key or value outside the pinned closed schema distrusts the
        // whole result: the safe fallback is "completion unknown", never
        // "not started".
        if !structured
            .keys()
            .all(|key| ACTION_RESULT_KEYS.contains(&key.as_str()))
        {
            return ActionView::default();
        }
        return action_result(&structured).unwrap_or_default();
    }
    // The refusal envelope (upstream `ToolResult::error` with
    // `{status:"refused", refusal:{code}}`) is the only "not started" outcome,
    // so every part of it must hold; otherwise completion is unknown.
    if structured.get("status").and_then(Value::as_str) == Some("refused") {
        let code = structured
            .get("refusal")
            .and_then(|refusal| ident(refusal.get("code")));
        return match code {
            Some(code) if is_error => ActionView {
                effect: Some("refused"),
                error_code: Some(code),
                ..ActionView::default()
            },
            _ => ActionView::default(),
        };
    }
    ActionView {
        error_code: ident(structured.get("code")),
        ..ActionView::default()
    }
}

fn action_result(result: &Map<String, Value>) -> Option<ActionView> {
    let delivery = optional(result.get("delivery"), |delivery| {
        let mode = pick(delivery.get("mode"), DELIVERY_MODES)?;
        let count = optional(delivery.get("delivered_count"), Value::as_u64)?;
        Some((mode, count))
    })?;
    let error_code = optional(result.get("error"), |error| ident(error.get("code")))?;
    let escalation = optional(result.get("escalation"), |escalation| {
        Some((
            pick(escalation.get("target"), ESCALATION_TARGETS)?,
            pick(escalation.get("reason"), ESCALATION_REASONS)?,
        ))
    })?;
    let evidence = optional(result.get("evidence"), |evidence| {
        evidence
            .as_array()?
            .iter()
            .map(|item| pick(item.get("kind"), EVIDENCE_KINDS))
            .collect::<Option<Vec<_>>>()
    })?;
    Some(ActionView {
        effect: Some(pick(result.get("effect"), EFFECTS)?),
        route: Some(pick(result.get("route"), ROUTES)?),
        delivery_mode: delivery.map(|(mode, _)| mode),
        delivered_count: delivery.and_then(|(_, count)| count),
        error_code,
        escalation,
        // `evidence` is optional in the pinned schema: absent means none.
        evidence: evidence.unwrap_or_default(),
    })
}

pub(super) fn permissions(payload: &Map<String, Value>) -> Result<Projection, EgressRefusal> {
    Ok(Projection::Permissions {
        accessibility: boolean(payload.get("accessibility"))?,
        screen_recording: boolean(payload.get("screen_recording"))?,
    })
}

pub(super) fn health(payload: &Map<String, Value>) -> Result<HealthView, EgressRefusal> {
    let overall = pick(payload.get("overall"), HEALTH_OVERALL).ok_or(EgressRefusal::Malformed)?;
    let checks = payload
        .get("checks")
        .and_then(Value::as_array)
        .filter(|checks| checks.len() <= MAX_HEALTH_CHECKS)
        .ok_or(EgressRefusal::Malformed)?;
    let checks = checks
        .iter()
        .map(|check| {
            Some((
                ident(check.get("name"))?,
                pick(check.get("status"), HEALTH_STATUS)?,
            ))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(EgressRefusal::Malformed)?;
    Ok(HealthView { overall, checks })
}
