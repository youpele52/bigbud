//! Frozen cua-driver 0.38.0 darwin argument profile for the tools bigbud
//! forwards (plan M2 "Primitive plan and delivery mapping"). Deliberately
//! narrower than the live schemas: model-derived arguments are typed and
//! bounded, bigbud's fixed bounds are exact values, and owner-only fields
//! (`session`, `pid`, `window_id`, `capture_id`) are never model arguments.
//! `profile.tests.rs` checks every entry against the pinned live-schema
//! fixture (`scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json`).
use serde_json::Value;

/// Bounds of `protocol/computer-use/plan.v1.golden.json` and the v2 contract.
pub const MAX_TEXT_UTF16: usize = 10_000;
pub const MAX_KEY_UTF16: usize = 128;
pub const MAX_CHORD_KEYS: usize = 64;
pub const MAX_ACCESSIBILITY_DEPTH: i64 = 50;
pub const SCROLL_CHUNK_MAX: i64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    GetWindowState,
    Click,
    Drag,
    Scroll,
    TypeText,
    PressKey,
    Hotkey,
    BringToFront,
    ListApps,
    ListWindows,
    CheckPermissions,
    HealthReport,
}

pub const TOOLS: [Tool; 12] = [
    Tool::GetWindowState,
    Tool::Click,
    Tool::Drag,
    Tool::Scroll,
    Tool::TypeText,
    Tool::PressKey,
    Tool::Hotkey,
    Tool::BringToFront,
    Tool::ListApps,
    Tool::ListWindows,
    Tool::CheckPermissions,
    Tool::HealthReport,
];

/// Owner-only fields, stamped from verified references.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stamp {
    Session,
    Pid,
    WindowId,
    CaptureId,
}

impl Stamp {
    pub const ALL: [Stamp; 4] = [Self::Session, Self::Pid, Self::WindowId, Self::CaptureId];
    pub fn field(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Pid => "pid",
            Self::WindowId => "window_id",
            Self::CaptureId => "capture_id",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// Finite, zero-based pixel coordinate.
    Pixel,
    Int {
        min: i64,
        max: i64,
    },
    Bool,
    OneOf(&'static [&'static str]),
    Text {
        max_utf16: usize,
        non_empty: bool,
    },
    /// Two or more non-empty key names.
    Chord,
    Exactly(Fixed),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fixed {
    Bool(bool),
    Int(i64),
    Str(&'static str),
    StrList(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArgSpec {
    pub name: &'static str,
    pub kind: Kind,
    pub required: bool,
}

const fn req(name: &'static str, kind: Kind) -> ArgSpec {
    ArgSpec {
        name,
        kind,
        required: true,
    }
}
const fn opt(name: &'static str, kind: Kind) -> ArgSpec {
    ArgSpec {
        name,
        kind,
        required: false,
    }
}

pub const DELIVERY: &[&str] = &["background", "foreground"];
const DELIVERY_MODE: ArgSpec = req("delivery_mode", Kind::OneOf(DELIVERY));
const TARGET: &[Stamp] = &[Stamp::Session, Stamp::Pid, Stamp::WindowId];
const SESSION: &[Stamp] = &[Stamp::Session];

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Self::GetWindowState => "get_window_state",
            Self::Click => "click",
            Self::Drag => "drag",
            Self::Scroll => "scroll",
            Self::TypeText => "type_text",
            Self::PressKey => "press_key",
            Self::Hotkey => "hotkey",
            Self::BringToFront => "bring_to_front",
            Self::ListApps => "list_apps",
            Self::ListWindows => "list_windows",
            Self::CheckPermissions => "check_permissions",
            Self::HealthReport => "health_report",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        TOOLS.into_iter().find(|tool| tool.name() == name)
    }

    /// Owner fields this tool takes. `capture_id` is stamped only when the
    /// consumed observation carries one; every other listed field is required.
    pub fn stamps(self) -> &'static [Stamp] {
        match self {
            Self::Click => &[
                Stamp::Session,
                Stamp::Pid,
                Stamp::WindowId,
                Stamp::CaptureId,
            ],
            Self::GetWindowState
            | Self::Drag
            | Self::Scroll
            | Self::TypeText
            | Self::PressKey
            | Self::Hotkey
            | Self::BringToFront => TARGET,
            Self::ListApps | Self::ListWindows | Self::CheckPermissions | Self::HealthReport => {
                SESSION
            }
        }
    }

    pub fn args(self) -> &'static [ArgSpec] {
        match self {
            Self::GetWindowState => GET_WINDOW_STATE_ARGS,
            Self::Click => CLICK_ARGS,
            Self::Drag => DRAG_ARGS,
            Self::Scroll => SCROLL_ARGS,
            Self::TypeText => TYPE_TEXT_ARGS,
            Self::PressKey => PRESS_KEY_ARGS,
            Self::Hotkey => HOTKEY_ARGS,
            Self::BringToFront | Self::ListApps | Self::ListWindows => &[],
            Self::CheckPermissions => CHECK_PERMISSIONS_ARGS,
            Self::HealthReport => HEALTH_REPORT_ARGS,
        }
    }
}

const PIXEL: Kind = Kind::Pixel;
const GET_WINDOW_STATE_ARGS: &[ArgSpec] = &[
    req("include_screenshot", Kind::Bool),
    req("include_accessibility_tree", Kind::Bool),
    opt("tree_format", Kind::Exactly(Fixed::Str("elements"))),
    opt("max_elements", Kind::Exactly(Fixed::Int(250))),
    opt(
        "max_depth",
        Kind::Int {
            min: 1,
            max: MAX_ACCESSIBILITY_DEPTH,
        },
    ),
    opt("timeout_ms", Kind::Exactly(Fixed::Int(1000))),
];
const CLICK_ARGS: &[ArgSpec] = &[
    req("x", PIXEL),
    req("y", PIXEL),
    DELIVERY_MODE,
    opt("button", Kind::OneOf(&["left", "middle", "right"])),
];
const DRAG_ARGS: &[ArgSpec] = &[
    req("from_x", PIXEL),
    req("from_y", PIXEL),
    req("to_x", PIXEL),
    req("to_y", PIXEL),
    DELIVERY_MODE,
    req("duration_ms", Kind::Exactly(Fixed::Int(500))),
    req("steps", Kind::Exactly(Fixed::Int(20))),
];
const SCROLL_ARGS: &[ArgSpec] = &[
    req("direction", Kind::OneOf(&["up", "down", "left", "right"])),
    req(
        "amount",
        Kind::Int {
            min: 1,
            max: SCROLL_CHUNK_MAX,
        },
    ),
    opt("x", PIXEL),
    opt("y", PIXEL),
    DELIVERY_MODE,
];
const TYPE_TEXT_ARGS: &[ArgSpec] = &[
    req(
        "text",
        Kind::Text {
            max_utf16: MAX_TEXT_UTF16,
            non_empty: false,
        },
    ),
    DELIVERY_MODE,
];
const PRESS_KEY_ARGS: &[ArgSpec] = &[
    req(
        "key",
        Kind::Text {
            max_utf16: MAX_KEY_UTF16,
            non_empty: true,
        },
    ),
    DELIVERY_MODE,
];
const HOTKEY_ARGS: &[ArgSpec] = &[req("keys", Kind::Chord), DELIVERY_MODE];
const CHECK_PERMISSIONS_ARGS: &[ArgSpec] = &[
    req("prompt", Kind::Exactly(Fixed::Bool(false))),
    req("probe_direct_capture", Kind::Exactly(Fixed::Bool(false))),
];
const HEALTH_REPORT_ARGS: &[ArgSpec] = &[req(
    "skip",
    Kind::Exactly(Fixed::StrList(&["screen_capture_capability"])),
)];

/// Whether `value` satisfies `kind` exactly (no numeric coercion).
pub fn admits(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Pixel => value.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0),
        Kind::Int { min, max } => value.as_i64().is_some_and(|v| (min..=max).contains(&v)),
        Kind::Bool => value.is_boolean(),
        Kind::OneOf(allowed) => value.as_str().is_some_and(|v| allowed.contains(&v)),
        Kind::Text {
            max_utf16,
            non_empty,
        } => value.as_str().is_some_and(|v| {
            (!non_empty || !v.is_empty()) && v.encode_utf16().count() <= max_utf16
        }),
        Kind::Chord => value.as_array().is_some_and(|keys| {
            (2..=MAX_CHORD_KEYS).contains(&keys.len()) && keys.iter().all(|key| admits(KEY, key))
        }),
        Kind::Exactly(fixed) => fixed.matches(value),
    }
}

const KEY: Kind = Kind::Text {
    max_utf16: MAX_KEY_UTF16,
    non_empty: true,
};

impl Fixed {
    pub fn matches(self, value: &Value) -> bool {
        match self {
            Self::Bool(expected) => value.as_bool() == Some(expected),
            // `as_i64` is `None` for any float representation: no coercion.
            Self::Int(expected) => value.as_i64() == Some(expected),
            Self::Str(expected) => value.as_str() == Some(expected),
            Self::StrList(expected) => value.as_array().is_some_and(|items| {
                items.len() == expected.len()
                    && items
                        .iter()
                        .zip(expected)
                        .all(|(item, want)| item.as_str() == Some(want))
            }),
        }
    }
}
