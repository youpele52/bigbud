#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
//! Cross-language parity: every driver step of the TypeScript golden plans
//! (`protocol/computer-use/plan.v1.golden.json`) is accepted by native
//! dispatch for a ticket derived independently from the public action, and
//! leaves stamped with exactly the owner fields the plan declares.
use super::dispatch::{Dispatch, NativeTarget, ObservationFrame, Stamps};
use super::ticket::{ACCESSIBILITY_DEFAULT_DEPTH, Admitted, Delivery, ScrollDirection, Ticket};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/computer-use/plan.v1.golden.json"
    );
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

const STAMPS: Stamps<'static> = Stamps {
    session: "c1",
    target: Some(NativeTarget { pid: 42, window: 7 }),
    observation: Some(ObservationFrame {
        width: 4096,
        height: 4096,
        capture_id: Some("cap-1"),
    }),
};

fn delivery(action: &Value, user_default: &str) -> Delivery {
    let spelled = action["background"]
        .as_bool()
        .map(|b| if b { "background" } else { "foreground" });
    match action["delivery"]
        .as_str()
        .or(spelled)
        .unwrap_or(user_default)
    {
        "foreground" => Delivery::Foreground,
        _ => Delivery::Background,
    }
}

/// Independent of the TypeScript plan: dominant axis, vertical wins ties.
fn scroll(action: &Value) -> Admitted {
    let (x, y) = (
        action["deltaX"].as_f64().unwrap_or(0.0),
        action["deltaY"].as_f64().unwrap_or(0.0),
    );
    let vertical = y.abs() >= x.abs();
    let dominant = if vertical { y } else { x };
    let direction = match (vertical, dominant < 0.0) {
        (true, true) => ScrollDirection::Up,
        (true, false) => ScrollDirection::Down,
        (false, true) => ScrollDirection::Left,
        (false, false) => ScrollDirection::Right,
    };
    let total = (dominant.abs().round() as i64).clamp(1, 100);
    Admitted::Scroll {
        direction,
        total,
        at_point: action.get("x").is_some(),
    }
}

/// `None` when the action reaches the Driver only through a fresh admission.
fn admitted(action: &Value) -> Option<Admitted> {
    let targeted = action.get("targetRef").is_some();
    Some(match action["action"].as_str().unwrap() {
        "capture" => Admitted::Capture,
        "get_page_info" => Admitted::PageInfo,
        "get_accessibility_tree" if targeted => Admitted::Tree {
            depth: action["maxDepth"]
                .as_i64()
                .unwrap_or(ACCESSIBILITY_DEFAULT_DEPTH),
        },
        "get_accessibility_tree" | "list_windows" => Admitted::ListWindows,
        "list_apps" => Admitted::ListApps,
        "click" => Admitted::Click,
        "drag" => Admitted::Drag,
        "type" => Admitted::Type,
        "key" => {
            let parts = action["key"]
                .as_str()
                .unwrap()
                .split('+')
                .filter(|k| !k.trim().is_empty());
            Admitted::Key {
                chord: parts.count() > 1,
            }
        }
        "scroll" => scroll(action),
        "focus_app" => Admitted::Focus,
        "check_permissions" => Admitted::CheckPermissions,
        "doctor" => Admitted::Doctor,
        "launch_app" | "navigate" | "wait" => return None,
        other => panic!("unmapped action {other}"),
    })
}

fn driver_steps(steps: &Value) -> Vec<&Value> {
    steps
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["kind"] == "driver")
        .collect()
}

fn forward(dispatch: &mut Dispatch, step: &Value, wire_id: u64) -> Map<String, Value> {
    let request = json!({"jsonrpc": "2.0", "id": "op-1.1", "method": "tools/call",
        "params": {"name": step["tool"], "arguments": step["arguments"]}});
    let out = dispatch.forward(&serde_json::to_vec(&request).unwrap(), &STAMPS, wire_id);
    let out = out.unwrap_or_else(|r| panic!("{step}: {r:?}"));
    assert_eq!(out.caller_id, json!("op-1.1"));
    let out: Value = serde_json::from_slice(&out.bytes).unwrap();
    assert_eq!(out["id"], json!(wire_id));
    assert_eq!(out["params"]["name"], step["tool"]);
    let mut expected = step["arguments"].as_object().unwrap().clone();
    for field in step["stamp"].as_array().unwrap() {
        let value = match field.as_str().unwrap() {
            "session" => json!("c1"),
            "pid" => json!(42),
            "window_id" => json!(7),
            "capture_id" => json!("cap-1"),
            other => panic!("unknown stamp {other}"),
        };
        expected.insert(field.as_str().unwrap().into(), value);
    }
    let sent = out["params"]["arguments"].as_object().unwrap().clone();
    assert_eq!(sent, expected, "{}", step["tool"]);
    sent
}

#[test]
fn native_dispatch_accepts_every_golden_plan_exactly() {
    let golden = golden();
    assert_eq!(golden["format"], "bigbud.computerUsePlan.v1");
    let mut forwarded = 0;
    for case in golden["cases"].as_array().unwrap() {
        let (action, plan) = (&case["action"], &case["plan"]);
        let steps = driver_steps(&plan["steps"]);
        let capture_after = plan.get("captureAfter");
        if capture_after.is_some() {
            // A later capture is always bound to a retained or verified target.
            let binding = plan["binding"].as_str().unwrap();
            assert!(
                ["target", "observation", "broker_target"].contains(&binding),
                "{}",
                case["name"]
            );
        }
        let Some(admitted) = admitted(action) else {
            assert!(steps.is_empty(), "{}", case["name"]);
            if let Some(capture) = capture_after {
                // A capture after wait/navigate is its own fresh admission of
                // the bound target.
                let ticket = Ticket {
                    admitted: Admitted::Capture,
                    delivery: Delivery::Background,
                    capture_after: false,
                };
                let mut dispatch = Dispatch::new(ticket).unwrap();
                forward(&mut dispatch, capture, forwarded);
                forwarded += 1;
                assert_eq!(dispatch.complete(), Ok(()), "{}", case["name"]);
            }
            continue;
        };
        let ticket = Ticket {
            admitted,
            delivery: delivery(action, case["userDefault"].as_str().unwrap()),
            capture_after: capture_after.is_some(),
        };
        let mut dispatch = Dispatch::new(ticket).unwrap();
        for step in &steps {
            forward(&mut dispatch, step, forwarded);
            forwarded += 1;
        }
        // The native plan has no steps left after the TypeScript plan's last.
        assert!(dispatch.finished(), "{}", case["name"]);
        assert_eq!(dispatch.complete(), Ok(()), "{}", case["name"]);
        if let Some(capture) = capture_after {
            forward(&mut dispatch, capture, forwarded);
            forwarded += 1;
        }
    }
    // Exactly every driver step and captureAfter of the golden file.
    assert_eq!(forwarded, 25);
}
