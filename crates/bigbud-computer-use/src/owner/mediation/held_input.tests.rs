#![allow(clippy::unwrap_used)]
use super::dispatch::{Dispatch, NativeTarget, ObservationFrame, Stamps};
use super::held_input::HeldInput;
use super::ticket::{Admitted, Delivery, Ticket};
use serde_json::{Value, json};

const STAMPS: Stamps<'static> = Stamps {
    session: "c1",
    target: Some(NativeTarget { pid: 42, window: 7 }),
    observation: Some(ObservationFrame {
        width: 100,
        height: 50,
        capture_id: Some("cap-1"),
    }),
};

fn ticket(admitted: Admitted) -> Dispatch {
    Dispatch::new(Ticket {
        admitted,
        delivery: Delivery::Background,
        capture_after: false,
    })
    .unwrap()
}

fn frame(tool: &str, arguments: Value) -> Vec<u8> {
    let request = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments}});
    serde_json::to_vec(&request).unwrap()
}

#[test]
fn forwarded_input_records_what_an_interruption_may_leave_held() {
    let mut dispatch = ticket(Admitted::Click);
    let args = json!({"x": 1, "y": 2, "delivery_mode": "background", "button": "right"});
    let out = dispatch.forward(&frame("click", args), &STAMPS, 1).unwrap();
    assert_eq!(out.held, vec![HeldInput::MouseButton("right")]);
    let mut chord = ticket(Admitted::Key { chord: true });
    let args = json!({"keys": ["cmd", "shift", "4"], "delivery_mode": "background"});
    let out = chord.forward(&frame("hotkey", args), &STAMPS, 2).unwrap();
    let keys = ["cmd", "shift", "4"].map(|key| HeldInput::Key(key.into()));
    assert_eq!(out.held, keys.to_vec());
    let mut list = ticket(Admitted::ListApps);
    let out = list
        .forward(&frame("list_apps", json!({})), &STAMPS, 3)
        .unwrap();
    assert!(out.held.is_empty());
}

#[test]
fn drag_text_and_single_keys_are_recorded_without_a_release() {
    let mut drag = ticket(Admitted::Drag);
    let args = json!({"from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4,
        "delivery_mode": "background", "duration_ms": 500, "steps": 20});
    let out = drag.forward(&frame("drag", args), &STAMPS, 1).unwrap();
    assert_eq!(out.held, vec![HeldInput::MouseButton("left")]);
    let mut typed = ticket(Admitted::Type);
    let args = json!({"text": "hi", "delivery_mode": "background"});
    let out = typed
        .forward(&frame("type_text", args), &STAMPS, 2)
        .unwrap();
    assert_eq!(out.held, vec![HeldInput::TextEntry]);
    let mut key = ticket(Admitted::Key { chord: false });
    let args = json!({"key": "return", "delivery_mode": "background"});
    let out = key.forward(&frame("press_key", args), &STAMPS, 3).unwrap();
    assert_eq!(out.held, vec![HeldInput::Key("return".into())]);
}
