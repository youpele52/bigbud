//! Targeted `get_window_state` projection. The reply must describe exactly
//! the stamped target, that target's application must still be permitted,
//! and a requested screenshot must be one PNG with a valid upstream frame;
//! otherwise nothing is returned. Elements keep only allowlisted fields.
use super::egress::{
    AppVerdict, EgressContext, EgressRefusal, MAX_LABEL_UTF16, boolean, optional_text, pid,
};
use super::response::Image;
use crate::owner::admission::limits::MAX_PROJECTED_IMAGE_BYTES;
use serde_json::{Map, Value};

/// `get_window_state` walks at most this many nodes (pinned by dispatch).
pub const MAX_ELEMENTS: usize = 250;
pub const MAX_VALUE_UTF16: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct CapturedImage {
    pub mime: &'static str,
    pub base64: String,
    pub width: u64,
    pub height: u64,
    pub scale: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElementView {
    pub index: u64,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub depth: u64,
    pub parent_index: Option<u64>,
    pub enabled: Option<bool>,
    pub selected: Option<bool>,
    /// x, y, width, height in screenshot pixels.
    pub frame: Option<[f64; 4]>,
    pub element_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowStateView {
    pub pid: u32,
    pub window_id: u64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub snapshot_id: Option<String>,
    pub capture_id: Option<String>,
    pub image: Option<CapturedImage>,
    pub elements: Vec<ElementView>,
    pub truncated: bool,
}

pub(super) fn window_state(
    payload: &Map<String, Value>,
    images: Vec<Image>,
    ctx: &EgressContext<'_>,
) -> Result<WindowStateView, EgressRefusal> {
    let (target, shape) = ctx.target.zip(ctx.read).ok_or(EgressRefusal::Malformed)?;
    let window_id = payload.get("window_id").and_then(Value::as_u64);
    if pid(payload.get("pid")) != Some(target.pid) || window_id != Some(target.window) {
        return Err(EgressRefusal::TargetMismatch);
    }
    if ctx.policy.verdict(target.pid) != AppVerdict::Permitted {
        return Err(EgressRefusal::AppDisallowed);
    }
    let snapshot_id = token(payload.get("snapshot_id"), is_snapshot_id)?;
    let capture_id = token(payload.get("capture_id"), is_capture_id)?;
    let image = if shape.screenshot {
        // darwin 0.38 registers a capture for every screenshot; without its
        // id a later click would silently lose the atomic capture binding.
        if capture_id.is_none() {
            return Err(EgressRefusal::ProvenanceUnproven);
        }
        Some(screenshot(payload, images)?)
    } else if images.is_empty() {
        None
    } else {
        return Err(EgressRefusal::Malformed);
    };
    let elements = if shape.tree {
        let raw = payload.get("elements").and_then(Value::as_array);
        let raw = raw
            .filter(|raw| raw.len() <= MAX_ELEMENTS)
            .ok_or(EgressRefusal::Malformed)?;
        raw.iter()
            .map(|value| element(value, snapshot_id.as_deref()))
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };
    Ok(WindowStateView {
        pid: target.pid,
        window_id: target.window,
        app_name: optional_text(payload.get("app_name"), MAX_LABEL_UTF16)?,
        window_title: optional_text(payload.get("window_title"), MAX_LABEL_UTF16)?,
        snapshot_id,
        capture_id,
        image,
        elements,
        // Upstream adds `truncated` only when the walk was cut short.
        truncated: match payload.get("truncated") {
            None | Some(Value::Null) => false,
            some => boolean(some)?,
        },
    })
}

fn screenshot(
    payload: &Map<String, Value>,
    images: Vec<Image>,
) -> Result<CapturedImage, EgressRefusal> {
    if payload
        .get("screenshot_frame_valid")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(EgressRefusal::ProvenanceUnproven);
    }
    let [image]: [Image; 1] = images
        .try_into()
        .map_err(|_| EgressRefusal::ProvenanceUnproven)?;
    let dimension = |key: &str| payload.get(key).and_then(Value::as_u64).filter(|v| *v > 0);
    let scale = payload.get("screenshot_scale").and_then(Value::as_f64);
    let (Some(width), Some(height), Some(scale)) = (
        dimension("screenshot_width"),
        dimension("screenshot_height"),
        scale.filter(|s| s.is_finite() && *s > 0.0),
    ) else {
        return Err(EgressRefusal::ProvenanceUnproven);
    };
    if image.mime != "image/png"
        || image.base64.len() > MAX_PROJECTED_IMAGE_BYTES
        || !image
            .base64
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        || png_dimensions(&image.base64) != Some((width, height))
    {
        return Err(EgressRefusal::ProvenanceUnproven);
    }
    Ok(CapturedImage {
        mime: "image/png",
        base64: image.base64,
        width,
        height,
        scale,
    })
}

/// The claimed size must be the PNG's own IHDR size (upstream reports
/// `png_dimensions` of the returned image), or the model's coordinates would
/// be bounded by a frame it never saw.
fn png_dimensions(base64: &str) -> Option<(u64, u64)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    // 32 base64 characters decode to the first 24 bytes: signature, IHDR
    // length and type, width and height.
    let mut bytes = Vec::with_capacity(24);
    for quad in base64.as_bytes().get(..32)?.chunks_exact(4) {
        let mut word = 0_u32;
        for &symbol in quad {
            word = (word << 6) | u32::from(sextet(symbol)?);
        }
        bytes.extend_from_slice(word.to_be_bytes().get(1..)?);
    }
    let header = bytes.get(..16)?;
    if header.get(..8)? != SIGNATURE || header.get(8..16)? != b"\0\0\0\x0dIHDR" {
        return None;
    }
    let field = |range: std::ops::Range<usize>| {
        let raw: [u8; 4] = bytes.get(range)?.try_into().ok()?;
        Some(u64::from(u32::from_be_bytes(raw)))
    };
    Some((field(16..20)?, field(20..24)?))
}

fn sextet(symbol: u8) -> Option<u8> {
    match symbol {
        b'A'..=b'Z' => Some(symbol - b'A'),
        b'a'..=b'z' => Some(symbol - b'a' + 26),
        b'0'..=b'9' => Some(symbol - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn element(value: &Value, snapshot_id: Option<&str>) -> Result<ElementView, EgressRefusal> {
    let record = value.as_object().ok_or(EgressRefusal::Malformed)?;
    let uint = |key: &str| record.get(key).and_then(Value::as_u64);
    let flag = |key: &str| match record.get(key) {
        None | Some(Value::Null) => Ok(None),
        some => boolean(some).map(Some),
    };
    let frame = match record.get("frame") {
        None | Some(Value::Null) => None,
        Some(frame) => {
            let edge = |key: &str| {
                frame
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
            };
            match (edge("x"), edge("y"), edge("w"), edge("h")) {
                (Some(x), Some(y), Some(w), Some(h)) => Some([x, y, w, h]),
                _ => return Err(EgressRefusal::Malformed),
            }
        }
    };
    Ok(ElementView {
        index: uint("element_index").ok_or(EgressRefusal::Malformed)?,
        role: optional_text(record.get("role"), MAX_LABEL_UTF16)?
            .ok_or(EgressRefusal::Malformed)?,
        label: optional_text(record.get("label"), MAX_LABEL_UTF16)?,
        value: optional_text(record.get("value"), MAX_VALUE_UTF16)?,
        depth: uint("depth").ok_or(EgressRefusal::Malformed)?,
        parent_index: match record.get("parent_index") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().ok_or(EgressRefusal::Malformed)?),
        },
        enabled: flag("enabled")?,
        selected: flag("selected")?,
        frame,
        element_token: element_token(record.get("element_token"), snapshot_id)?,
    })
}

/// A token must name the snapshot this reply reports.
fn element_token(
    value: Option<&Value>,
    snapshot_id: Option<&str>,
) -> Result<Option<String>, EgressRefusal> {
    let token = token(value, is_element_token)?;
    match (&token, snapshot_id) {
        (None, _) => Ok(None),
        (Some(text), Some(snapshot)) if text.split_once(':').map(|(s, _)| s) == Some(snapshot) => {
            Ok(token)
        }
        _ => Err(EgressRefusal::Malformed),
    }
}

fn token(value: Option<&Value>, valid: fn(&str) -> bool) -> Result<Option<String>, EgressRefusal> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if valid(text) => Ok(Some(text.clone())),
        Some(_) => Err(EgressRefusal::Malformed),
    }
}

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `s` + 8 lowercase hex digits (cua-driver `format_snapshot_id`).
fn is_snapshot_id(text: &str) -> bool {
    text.strip_prefix('s').is_some_and(|hex| lower_hex(hex, 8))
}

/// `<snapshot_id>:<row>` (pinned `element_token_schema` pattern).
fn is_element_token(text: &str) -> bool {
    text.split_once(':').is_some_and(|(snapshot, row)| {
        is_snapshot_id(snapshot) && !row.is_empty() && row.bytes().all(|b| b.is_ascii_digit())
    })
}

/// Canonical `CaptureId` display (pinned `capture_registry.rs` 51-58):
/// `capture_<32 lowercase hex>_<16 lowercase hex>`.
fn is_capture_id(text: &str) -> bool {
    text.strip_prefix("capture_")
        .and_then(|rest| rest.split_once('_'))
        .is_some_and(|(namespace, sequence)| lower_hex(namespace, 32) && lower_hex(sequence, 16))
}
