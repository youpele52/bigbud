#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
//! The frozen profile against the pinned 0.38.0 live-schema fixture.
use super::profile::{Fixed, Kind, Stamp, TOOLS, Tool, admits};
use serde_json::Value;

fn live() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json"
    );
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn fixed_value(fixed: Fixed) -> Value {
    match fixed {
        Fixed::Bool(value) => Value::from(value),
        Fixed::Int(value) => Value::from(value),
        Fixed::Str(value) => Value::from(value),
        Fixed::StrList(values) => Value::from(values.to_vec()),
    }
}

/// Whether every value `kind` admits is accepted by the live property schema
/// (types, enums and numeric bounds; the profile may only be narrower).
fn narrower_than(kind: Kind, live: &Value) -> bool {
    let ty = live["type"].as_str().unwrap();
    let within = |min: i64, max: i64| {
        live["minimum"].as_i64().is_none_or(|lo| lo <= min)
            && live["maximum"].as_i64().is_none_or(|hi| max <= hi)
    };
    match kind {
        Kind::Pixel => ty == "number",
        Kind::Int { min, max } => ty == "integer" && within(min, max),
        Kind::Bool => ty == "boolean",
        Kind::OneOf(allowed) => {
            ty == "string"
                && live["enum"].as_array().is_none_or(|values| {
                    allowed
                        .iter()
                        .all(|value| values.contains(&Value::from(*value)))
                })
        }
        Kind::Text { .. } => ty == "string" && live.get("enum").is_none(),
        Kind::Chord => {
            ty == "array"
                && live["items"]["type"] == "string"
                && live["minItems"].as_u64().is_none_or(|n| n <= 2)
        }
        Kind::Exactly(fixed) => {
            let value = fixed_value(fixed);
            let typed = match ty {
                "boolean" => value.is_boolean(),
                "integer" => value.is_i64(),
                "string" => value.is_string(),
                "array" => value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string)),
                _ => false,
            };
            typed
                && live["enum"]
                    .as_array()
                    .is_none_or(|values| values.contains(&value))
                && value.as_i64().is_none_or(|v| within(v, v))
        }
    }
}

#[test]
fn every_profile_argument_exists_in_the_live_schema_and_is_narrower() {
    let live = live();
    for tool in TOOLS {
        let schema = &live["tools"][tool.name()]["inputSchema"];
        assert_eq!(schema["additionalProperties"], false, "{}", tool.name());
        for spec in tool.args() {
            let property = &schema["properties"][spec.name];
            assert!(property.is_object(), "{}.{}", tool.name(), spec.name);
            assert!(
                narrower_than(spec.kind, property),
                "{}.{}",
                tool.name(),
                spec.name
            );
            if let Kind::Exactly(fixed) = spec.kind {
                assert!(admits(spec.kind, &fixed_value(fixed)));
            }
        }
    }
}

#[test]
fn stamps_exist_live_and_capture_ids_are_never_invented() {
    let live = live();
    for tool in TOOLS {
        let properties = &live["tools"][tool.name()]["inputSchema"]["properties"];
        for stamp in tool.stamps() {
            assert!(
                properties[stamp.field()].is_object(),
                "{}.{}",
                tool.name(),
                stamp.field()
            );
        }
        let stamps_capture = tool.stamps().contains(&Stamp::CaptureId);
        assert_eq!(stamps_capture, tool == Tool::Click, "{}", tool.name());
        // No owner field is ever also a model argument.
        for stamp in Stamp::ALL {
            assert!(tool.args().iter().all(|spec| spec.name != stamp.field()));
        }
    }
    for tool in ["drag", "scroll", "type_text", "press_key", "hotkey"] {
        assert!(live["tools"][tool]["inputSchema"]["properties"]["capture_id"].is_null());
    }
}

#[test]
fn every_live_required_property_is_covered_by_a_required_argument_or_stamp() {
    let live = live();
    for tool in TOOLS {
        let schema = &live["tools"][tool.name()]["inputSchema"];
        for required in schema["required"].as_array().into_iter().flatten() {
            let name = required.as_str().unwrap();
            let argument = tool
                .args()
                .iter()
                .any(|spec| spec.required && spec.name == name);
            let stamped = tool.stamps().iter().any(|stamp| stamp.field() == name);
            assert!(argument || stamped, "{}.{name}", tool.name());
        }
    }
}

#[test]
fn tool_names_round_trip_and_unknown_tools_are_absent() {
    for tool in TOOLS {
        assert_eq!(Tool::from_name(tool.name()), Some(tool));
    }
    for name in [
        "kill_app",
        "launch_app",
        "run_steps",
        "get_desktop_state",
        "Click",
        "",
    ] {
        assert_eq!(Tool::from_name(name), None);
    }
}

#[test]
fn admission_never_coerces_numbers_or_strings() {
    let int = Kind::Int { min: 1, max: 50 };
    assert!(admits(int, &serde_json::json!(3)));
    for bad in [
        serde_json::json!(3.0),
        serde_json::json!("3"),
        serde_json::json!(51),
    ] {
        assert!(!admits(int, &bad));
    }
    assert!(admits(Kind::Pixel, &serde_json::json!(0)));
    assert!(!admits(Kind::Pixel, &serde_json::json!(-0.5)));
    assert!(!admits(Kind::Pixel, &serde_json::json!("1")));
    assert!(!admits(
        Kind::Exactly(Fixed::Int(250)),
        &serde_json::json!(250.0)
    ));
    assert!(!admits(
        Kind::Exactly(Fixed::Bool(false)),
        &serde_json::json!(0)
    ));
    assert!(!admits(Kind::Chord, &serde_json::json!(["cmd"])));
    assert!(!admits(Kind::Chord, &serde_json::json!(["cmd", ""])));
}
