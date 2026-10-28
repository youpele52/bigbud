//! What an interrupted input call may still hold (M4.uncertainty). Derived
//! only from what the owner itself forwarded (already validated against the
//! frozen profile), never from Driver output, and used only to tell the human
//! what to release during explicit recovery. Nothing here sends a release:
//! blind global releases could disrupt the human's own input, and killing a
//! worker cannot retract OS-delivered events.
use super::profile::Tool;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldInput {
    MouseButton(&'static str),
    /// A key name exactly as forwarded (profile-bounded).
    Key(String),
    /// Text entry exposes no per-key transitions on this route; any key may
    /// be affected.
    TextEntry,
}

const BUTTONS: [&str; 3] = ["left", "middle", "right"];

fn key(value: &Value) -> Option<HeldInput> {
    value.as_str().map(|key| HeldInput::Key(key.to_owned()))
}

/// Inputs the call could leave pressed if its outcome becomes unknown.
pub fn possibly_held(tool: Tool, arguments: &Map<String, Value>) -> Vec<HeldInput> {
    match tool {
        // Absent `button` is the Driver's documented default, left (upstream
        // click.rs tool description; drag.rs 162); the frozen drag profile
        // admits no button at all.
        Tool::Click | Tool::Drag => {
            let button = arguments.get("button").and_then(Value::as_str);
            let button = BUTTONS
                .into_iter()
                .find(|known| Some(*known) == button)
                .unwrap_or("left");
            vec![HeldInput::MouseButton(button)]
        }
        Tool::PressKey => arguments.get("key").and_then(key).into_iter().collect(),
        Tool::Hotkey => arguments
            .get("keys")
            .and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(key).collect())
            .unwrap_or_default(),
        Tool::TypeText => vec![HeldInput::TextEntry],
        Tool::GetWindowState
        | Tool::Scroll
        | Tool::BringToFront
        | Tool::ListApps
        | Tool::ListWindows
        | Tool::CheckPermissions
        | Tool::HealthReport => Vec::new(),
    }
}
