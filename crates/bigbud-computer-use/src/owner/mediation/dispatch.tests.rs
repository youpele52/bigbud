#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
use super::dispatch::{Dispatch, DispatchRefusal, NativeTarget, ObservationFrame, Stamps};
use super::frame::FrameRefusal;
use super::ticket::{Admitted, Delivery, ScrollDirection, Ticket};
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

fn ticket(admitted: Admitted, delivery: Delivery, capture_after: bool) -> Dispatch {
    Dispatch::new(Ticket {
        admitted,
        delivery,
        capture_after,
    })
    .unwrap()
}

fn frame(tool: &str, arguments: Value) -> Vec<u8> {
    let request = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments}});
    serde_json::to_vec(&request).unwrap()
}

fn sent(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).unwrap()["params"]["arguments"].clone()
}

fn click(delivery: &str, x: f64) -> Vec<u8> {
    frame("click", json!({"x": x, "y": 2, "delivery_mode": delivery}))
}

#[test]
fn background_click_is_stamped_and_reserialized() {
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
    let out = dispatch
        .forward(&click("background", 1.5), &STAMPS, 1)
        .unwrap();
    assert_eq!(
        sent(&out.bytes),
        json!({"x": 1.5, "y": 2, "delivery_mode": "background", "session": "c1",
            "pid": 42, "window_id": 7, "capture_id": "cap-1"})
    );
    // The sequence is complete: nothing further may run.
    assert_eq!(
        dispatch.forward(&click("background", 1.0), &STAMPS, 1),
        Err(DispatchRefusal::Unexpected)
    );
}

#[test]
fn model_supplied_owner_fields_and_unknown_arguments_refuse_and_close() {
    for (field, value) in [
        ("pid", json!(1)),
        ("window_id", json!(1)),
        ("session", json!("x")),
        ("capture_id", json!("c")),
    ] {
        let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
        let mut args = json!({"x": 1, "y": 2, "delivery_mode": "background"});
        args[field] = value;
        let refusal = dispatch
            .forward(&frame("click", args), &STAMPS, 1)
            .unwrap_err();
        assert!(matches!(refusal, DispatchRefusal::OwnerField(_)), "{field}");
        assert_eq!(refusal.code(), "invalid_arguments");
        // A refusal closes the operation even for a valid next frame.
        assert_eq!(
            dispatch.forward(&click("background", 1.0), &STAMPS, 1),
            Err(DispatchRefusal::Unexpected)
        );
    }
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
    let args = json!({"x": 1, "y": 2, "delivery_mode": "background", "debug_image_out": "/tmp/x"});
    assert_eq!(
        dispatch.forward(&frame("click", args), &STAMPS, 1),
        Err(DispatchRefusal::InvalidArgument("unknown"))
    );
}

#[test]
fn foreground_requires_the_prelude_and_the_admitted_delivery() {
    let mut dispatch = ticket(Admitted::Click, Delivery::Foreground, false);
    assert_eq!(
        dispatch.forward(&click("foreground", 1.0), &STAMPS, 1),
        Err(DispatchRefusal::Unexpected)
    );
    let mut dispatch = ticket(Admitted::Click, Delivery::Foreground, false);
    let front = dispatch
        .forward(&frame("bring_to_front", json!({})), &STAMPS, 1)
        .unwrap();
    assert_eq!(
        sent(&front.bytes),
        json!({"session": "c1", "pid": 42, "window_id": 7})
    );
    // Background cannot be swapped in after a foreground admission.
    assert_eq!(
        dispatch.forward(&click("background", 1.0), &STAMPS, 1),
        Err(DispatchRefusal::InvalidArgument("delivery_mode"))
    );
    let mut background = ticket(Admitted::Type, Delivery::Background, false);
    assert_eq!(
        background.forward(&frame("bring_to_front", json!({})), &STAMPS, 1),
        Err(DispatchRefusal::Unexpected)
    );
}

#[test]
fn pixels_must_lie_inside_the_consumed_observation() {
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
    assert_eq!(
        dispatch.forward(&click("background", 100.0), &STAMPS, 1),
        Err(DispatchRefusal::OutsideFrame)
    );
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
    let no_observation = Stamps {
        observation: None,
        ..STAMPS
    };
    let refusal = dispatch
        .forward(&click("background", 1.0), &no_observation, 1)
        .unwrap_err();
    assert_eq!(refusal.code(), "observation_missing");
    let mut drag = ticket(Admitted::Drag, Delivery::Background, false);
    let args = json!({"from_x": 1, "from_y": 1, "to_x": 1, "to_y": 50, "delivery_mode": "background",
        "duration_ms": 500, "steps": 20});
    assert_eq!(
        drag.forward(&frame("drag", args), &STAMPS, 1),
        Err(DispatchRefusal::OutsideFrame)
    );
}

#[test]
fn a_capture_without_an_id_is_not_invented_and_targets_are_required() {
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, false);
    let frame_only = Stamps {
        observation: Some(ObservationFrame {
            width: 10,
            height: 10,
            capture_id: None,
        }),
        ..STAMPS
    };
    let out = dispatch
        .forward(&click("background", 1.0), &frame_only, 1)
        .unwrap();
    assert!(sent(&out.bytes).get("capture_id").is_none());
    let mut type_text = ticket(Admitted::Type, Delivery::Background, false);
    let untargeted = Stamps {
        target: None,
        ..STAMPS
    };
    let args = json!({"text": "hi", "delivery_mode": "background"});
    let refusal = type_text
        .forward(&frame("type_text", args), &untargeted, 1)
        .unwrap_err();
    assert_eq!(refusal.code(), "target_missing");
}

#[test]
fn scroll_chunks_follow_the_admitted_direction_and_total_exactly() {
    let admitted = Admitted::Scroll {
        direction: ScrollDirection::Down,
        total: 80,
        at_point: false,
    };
    let chunk = |amount: i64, direction: &str| {
        frame(
            "scroll",
            json!({"direction": direction, "amount": amount, "delivery_mode": "background"}),
        )
    };
    let mut dispatch = ticket(admitted, Delivery::Background, false);
    dispatch.forward(&chunk(50, "down"), &STAMPS, 1).unwrap();
    dispatch.forward(&chunk(30, "down"), &STAMPS, 1).unwrap();
    assert_eq!(
        dispatch.forward(&chunk(1, "down"), &STAMPS, 1),
        Err(DispatchRefusal::Unexpected)
    );
    for (first, direction) in [(30, "down"), (50, "up")] {
        let mut dispatch = ticket(admitted, Delivery::Background, false);
        assert_eq!(
            dispatch.forward(&chunk(first, direction), &STAMPS, 1),
            Err(DispatchRefusal::InvalidArgument("scroll"))
        );
    }
    // A coordinate-free admission refuses invented coordinates.
    let mut dispatch = ticket(admitted, Delivery::Background, false);
    let pointed =
        json!({"direction": "down", "amount": 50, "x": 1, "y": 1, "delivery_mode": "background"});
    assert_eq!(
        dispatch.forward(&frame("scroll", pointed), &STAMPS, 1),
        Err(DispatchRefusal::InvalidArgument("scroll"))
    );
}

#[test]
fn reads_keep_their_admitted_shape() {
    let tree = ticket(Admitted::Tree { depth: 7 }, Delivery::Background, false);
    let full = json!({"include_screenshot": false, "include_accessibility_tree": true,
        "tree_format": "elements", "max_elements": 250, "max_depth": 7, "timeout_ms": 1000});
    let mut ok = tree;
    ok.forward(&frame("get_window_state", full.clone()), &STAMPS, 1)
        .unwrap();
    for (field, value) in [
        ("max_depth", json!(8)),
        ("include_screenshot", json!(true)),
        ("max_elements", json!(2000)),
        ("timeout_ms", json!(5000)),
    ] {
        let mut dispatch = ticket(Admitted::Tree { depth: 7 }, Delivery::Background, false);
        let mut args = full.clone();
        args[field] = value;
        assert!(
            dispatch
                .forward(&frame("get_window_state", args), &STAMPS, 1)
                .is_err(),
            "{field}"
        );
    }
    let mut capture = ticket(Admitted::Capture, Delivery::Background, false);
    assert!(
        capture
            .forward(&frame("get_window_state", full), &STAMPS, 1)
            .is_err()
    );
    assert!(
        Dispatch::new(Ticket {
            admitted: Admitted::Tree { depth: 51 },
            delivery: Delivery::Background,
            capture_after: false
        })
        .is_err()
    );
}

#[test]
fn capture_after_runs_once_and_only_after_known_completion() {
    let capture = frame(
        "get_window_state",
        json!({"include_screenshot": true, "include_accessibility_tree": false}),
    );
    // Claiming completion before every step ran refuses and closes.
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, true);
    assert!(!dispatch.finished());
    assert_eq!(dispatch.complete(), Err(DispatchRefusal::Unexpected));
    assert_eq!(
        dispatch.forward(&click("background", 1.0), &STAMPS, 1),
        Err(DispatchRefusal::Unexpected)
    );
    // Without a completion claim the capture never runs.
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, true);
    dispatch
        .forward(&click("background", 1.0), &STAMPS, 1)
        .unwrap();
    assert_eq!(
        dispatch.forward(&capture, &STAMPS, 2),
        Err(DispatchRefusal::Unexpected)
    );
    let mut dispatch = ticket(Admitted::Click, Delivery::Background, true);
    dispatch
        .forward(&click("background", 1.0), &STAMPS, 1)
        .unwrap();
    assert!(dispatch.finished());
    assert_eq!(dispatch.complete(), Ok(()));
    dispatch.forward(&capture, &STAMPS, 2).unwrap();
    assert_eq!(
        dispatch.forward(&capture, &STAMPS, 3),
        Err(DispatchRefusal::Unexpected)
    );
}

#[test]
fn a_driver_refusal_or_unknown_outcome_stops_the_operation() {
    let chunk = |amount: i64| {
        frame(
            "scroll",
            json!({"direction": "down", "amount": amount, "delivery_mode": "background"}),
        )
    };
    let scroll = Admitted::Scroll {
        direction: ScrollDirection::Down,
        total: 80,
        at_point: false,
    };
    let mut dispatch = ticket(scroll, Delivery::Background, true);
    dispatch.forward(&chunk(50), &STAMPS, 1).unwrap();
    dispatch.abort();
    assert_eq!(
        dispatch.forward(&chunk(30), &STAMPS, 2),
        Err(DispatchRefusal::Unexpected)
    );
    assert!(!dispatch.finished());
    assert_eq!(dispatch.complete(), Err(DispatchRefusal::Unexpected));
}

#[test]
fn the_owner_assigns_the_wire_id_and_pins_session_and_target() {
    let mut dispatch = ticket(Admitted::Click, Delivery::Foreground, false);
    let front = dispatch
        .forward(&frame("bring_to_front", json!({})), &STAMPS, 41)
        .unwrap();
    assert_eq!(front.caller_id, json!(9));
    let wire: Value = serde_json::from_slice(&front.bytes).unwrap();
    assert_eq!(wire["id"], json!(41));
    let mut moved = STAMPS;
    moved.target = Some(NativeTarget { pid: 42, window: 8 });
    assert_eq!(
        dispatch.forward(&click("foreground", 1.0), &moved, 42),
        Err(DispatchRefusal::TargetChanged)
    );
    let mut dispatch = ticket(Admitted::Click, Delivery::Foreground, false);
    dispatch
        .forward(&frame("bring_to_front", json!({})), &STAMPS, 43)
        .unwrap();
    let other_session = Stamps {
        session: "c2",
        ..STAMPS
    };
    assert_eq!(
        dispatch
            .forward(&click("foreground", 1.0), &other_session, 44)
            .map_err(|refusal| refusal.code()),
        Err("target_stale")
    );
}

#[test]
fn capture_after_is_admitted_only_for_mutations() {
    for admitted in [
        Admitted::Doctor,
        Admitted::ListApps,
        Admitted::CheckPermissions,
        Admitted::Capture,
        Admitted::Tree { depth: 5 },
        Admitted::Focus,
    ] {
        let refused = Dispatch::new(Ticket {
            admitted,
            delivery: Delivery::Background,
            capture_after: true,
        });
        assert_eq!(refused.err(), Some(DispatchRefusal::InvalidTicket));
    }
}

#[test]
fn malformed_and_foreign_frames_refuse() {
    let mut dispatch = ticket(Admitted::ListApps, Delivery::Background, false);
    let bad = [
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"name":"list_apps","arguments":{}}}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":-1,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_apps","arguments":{},"_meta":{}}}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_apps","arguments":[]}}"#.to_vec(),
    ];
    for frame in bad {
        let mut dispatch = ticket(Admitted::ListApps, Delivery::Background, false);
        assert_eq!(
            dispatch.forward(&frame, &STAMPS, 1),
            Err(DispatchRefusal::Frame(FrameRefusal::Shape))
        );
    }
    assert_eq!(
        dispatch.forward(&frame("kill_app", json!({})), &STAMPS, 1),
        Err(DispatchRefusal::Frame(FrameRefusal::UnknownTool))
    );
}
