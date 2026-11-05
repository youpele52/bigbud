//! Trusted egress projection (plan M3 "Application restrictions", M3.egress).
//! A raw Driver reply is never forwarded: every representation is rebuilt
//! from the structured payload, restricted to records whose process native
//! policy currently permits (record text and labels are never consulted), and
//! bounded. Upstream text, counts, summaries, hints, next calls and error
//! prose are dropped; discovery stacking is re-ranked so gaps cannot reveal
//! excluded windows. Reads are withheld when the applied policy revision or
//! pause epoch moved after admission. Dormant: not wired to a transport.
use super::dispatch::NativeTarget;
use super::profile::Tool;
use super::response::{ResponseRefusal, ToolResponse, parse_tool_response};
use serde_json::{Map, Value};

pub use super::egress_read::{CapturedImage, ElementView, WindowStateView};
pub use super::egress_result::{ActionView, HealthView};

/// Raw discovery arrays larger than this refuse instead of being truncated.
pub const MAX_DISCOVERY_RECORDS: usize = 1024;
pub const MAX_LABEL_UTF16: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppVerdict {
    Permitted,
    Disallowed,
    /// No verified identity or ambiguous ownership: treated as excluded.
    Unverified,
}

/// Native decision for a process from its verified identity under the
/// current applied policy. Egress never asks about pid 0 (upstream reports
/// installed-but-not-running apps with pid 0) or about records that are not
/// running; an implementation must still never answer `Permitted` for a pid
/// without a live verified process. Known limit: upstream reports no process
/// start identity, so a pid reused between the Driver's listing and this
/// verdict is judged as the new process.
pub trait AppPolicy {
    fn verdict(&self, pid: u32) -> AppVerdict;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Authority {
    pub policy_revision: u64,
    pub pause_epoch: u64,
}

/// What an admitted `get_window_state` asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadShape {
    pub screenshot: bool,
    pub tree: bool,
}

pub struct EgressContext<'a> {
    /// The owner-assigned wire id the frame was forwarded with
    /// (`Forwarded` bytes), never the caller's id.
    pub wire_id: u64,
    pub admitted: Authority,
    pub current: Authority,
    pub policy: &'a dyn AppPolicy,
    pub target: Option<NativeTarget>,
    pub read: Option<ReadShape>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressRefusal {
    Response(ResponseRefusal),
    Malformed,
    Paused,
    PolicyChanged,
    AppDisallowed,
    TargetMismatch,
    ProvenanceUnproven,
    ReadFailed { targeted: bool },
}

impl EgressRefusal {
    /// Frozen public v2 error code; never carries Driver text.
    pub fn code(self) -> &'static str {
        match self {
            Self::Response(_) | Self::Malformed | Self::ReadFailed { targeted: false } => {
                "control_unavailable"
            }
            Self::Paused => "paused",
            Self::PolicyChanged => "policy_pending",
            Self::AppDisallowed => "app_disallowed",
            Self::TargetMismatch | Self::ReadFailed { targeted: true } => "target_stale",
            Self::ProvenanceUnproven => "capture_provenance_unproven",
        }
    }
}

/// A running permitted application (not-running records are never projected).
#[derive(Debug, Clone, PartialEq)]
pub struct AppView {
    pub pid: u32,
    pub name: String,
    pub bundle_id: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowView {
    pub pid: u32,
    pub window_id: u64,
    pub app_name: String,
    pub title: String,
    /// x, y, width, height in screen points.
    pub bounds: [f64; 4],
    pub on_screen: bool,
    /// Dense rank among the permitted windows; the maximum is frontmost.
    pub stack: Option<u32>,
}

/// What the Driver said about `bring_to_front`. Never authoritative: the
/// window may have been raised even when the reply is an error, so the
/// owner's native `verify_foreground` decides; anything it cannot prove is
/// `foreground_unavailable` with completion unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusReport {
    Reported,
    Refused,
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Projection {
    Apps(Vec<AppView>),
    Windows(Vec<WindowView>),
    WindowState(WindowStateView),
    Action(ActionView),
    Focus(FocusReport),
    Permissions {
        accessibility: bool,
        screen_recording: bool,
    },
    Health(HealthView),
}

pub fn project(
    tool: Tool,
    bytes: &[u8],
    ctx: &EgressContext<'_>,
) -> Result<Projection, EgressRefusal> {
    let read = matches!(
        tool,
        Tool::GetWindowState | Tool::ListApps | Tool::ListWindows
    );
    if read && ctx.current.pause_epoch != ctx.admitted.pause_epoch {
        return Err(EgressRefusal::Paused);
    }
    if read && ctx.current.policy_revision != ctx.admitted.policy_revision {
        return Err(EgressRefusal::PolicyChanged);
    }
    let response = parse_tool_response(bytes, ctx.wire_id);
    match tool {
        // A mutation's outcome is never refused away: a malformed reply only
        // makes its completion unknown.
        Tool::Click
        | Tool::Drag
        | Tool::Scroll
        | Tool::TypeText
        | Tool::PressKey
        | Tool::Hotkey => Ok(Projection::Action(super::egress_result::action(
            response.ok(),
        ))),
        Tool::BringToFront => Ok(Projection::Focus(match response {
            Ok(response) if response.is_error => FocusReport::Refused,
            Ok(_) => FocusReport::Reported,
            Err(_) => FocusReport::Unknown,
        })),
        _ => {
            let response = response.map_err(EgressRefusal::Response)?;
            match tool {
                Tool::ListApps => apps(&ok(response, false)?, ctx).map(Projection::Apps),
                Tool::ListWindows => windows(&ok(response, false)?, ctx).map(Projection::Windows),
                Tool::GetWindowState => {
                    let images = response.images.clone();
                    super::egress_read::window_state(&ok(response, true)?, images, ctx)
                        .map(Projection::WindowState)
                }
                Tool::CheckPermissions => super::egress_result::permissions(&ok(response, false)?),
                _ => super::egress_result::health(&ok(response, false)?).map(Projection::Health),
            }
        }
    }
}

/// The structured payload of a successful read.
fn ok(response: ToolResponse, targeted: bool) -> Result<Map<String, Value>, EgressRefusal> {
    if response.is_error {
        return Err(EgressRefusal::ReadFailed { targeted });
    }
    response.structured.ok_or(EgressRefusal::Malformed)
}

pub(super) fn text(value: Option<&Value>, max_utf16: usize) -> Result<String, EgressRefusal> {
    value
        .and_then(Value::as_str)
        .filter(|text| text.encode_utf16().count() <= max_utf16)
        .map(str::to_owned)
        .ok_or(EgressRefusal::Malformed)
}

pub(super) fn optional_text(
    value: Option<&Value>,
    max_utf16: usize,
) -> Result<Option<String>, EgressRefusal> {
    match value {
        None | Some(Value::Null) => Ok(None),
        some => text(some, max_utf16).map(Some),
    }
}

pub(super) fn boolean(value: Option<&Value>) -> Result<bool, EgressRefusal> {
    value
        .and_then(Value::as_bool)
        .ok_or(EgressRefusal::Malformed)
}

pub(super) fn pid(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
}

fn records<'a>(
    payload: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Vec<Value>, EgressRefusal> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .filter(|records| records.len() <= MAX_DISCOVERY_RECORDS)
        .ok_or(EgressRefusal::Malformed)
}

/// pid 0 never names a live process, so its verdict is never asked.
fn permitted(ctx: &EgressContext<'_>, pid: Option<u32>) -> Option<u32> {
    pid.filter(|pid| *pid != 0 && ctx.policy.verdict(*pid) == AppVerdict::Permitted)
}

fn apps(
    payload: &Map<String, Value>,
    ctx: &EgressContext<'_>,
) -> Result<Vec<AppView>, EgressRefusal> {
    let mut out = Vec::new();
    for record in records(payload, "apps")? {
        let record = record.as_object().ok_or(EgressRefusal::Malformed)?;
        // Installed-but-not-running apps have no live identity to verify:
        // dropped before any verdict (fails closed; launch resolves by name).
        if record.get("running") != Some(&Value::Bool(true)) {
            continue;
        }
        let Some(pid) = permitted(ctx, pid(record.get("pid"))) else {
            continue;
        };
        out.push(AppView {
            pid,
            name: text(record.get("name"), MAX_LABEL_UTF16)?,
            bundle_id: optional_text(record.get("bundle_id"), MAX_LABEL_UTF16)?,
            active: boolean(record.get("active"))?,
        });
    }
    Ok(out)
}

fn windows(
    payload: &Map<String, Value>,
    ctx: &EgressContext<'_>,
) -> Result<Vec<WindowView>, EgressRefusal> {
    let mut out = Vec::new();
    let mut stacking = Vec::new();
    for record in records(payload, "windows")? {
        let record = record.as_object().ok_or(EgressRefusal::Malformed)?;
        let Some(pid) = permitted(ctx, pid(record.get("pid"))) else {
            continue;
        };
        let bounds = record.get("bounds").ok_or(EgressRefusal::Malformed)?;
        let edge = |key: &str| {
            bounds
                .get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
        };
        let (Some(x), Some(y), Some(width), Some(height)) =
            (edge("x"), edge("y"), edge("width"), edge("height"))
        else {
            return Err(EgressRefusal::Malformed);
        };
        let z_index = match record.get("z_index") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_i64().ok_or(EgressRefusal::Malformed)?),
        };
        stacking.push(z_index);
        out.push(WindowView {
            pid,
            window_id: record
                .get("window_id")
                .and_then(Value::as_u64)
                .ok_or(EgressRefusal::Malformed)?,
            app_name: text(record.get("app_name"), MAX_LABEL_UTF16)?,
            title: text(record.get("title"), MAX_LABEL_UTF16)?,
            bounds: [x, y, width, height],
            on_screen: boolean(record.get("is_on_screen"))?,
            stack: None,
        });
    }
    // Dense ranks preserve order without exposing gaps left by exclusions.
    let mut known: Vec<i64> = stacking.iter().flatten().copied().collect();
    known.sort_unstable();
    known.dedup();
    for (window, z_index) in out.iter_mut().zip(stacking) {
        window.stack = z_index
            .and_then(|z| known.binary_search(&z).ok())
            .and_then(|rank| u32::try_from(rank).ok());
    }
    Ok(out)
}
