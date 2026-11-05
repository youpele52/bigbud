#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
use super::dispatch::NativeTarget;
use super::egress::{EgressRefusal, Projection, ReadShape, project};
use super::egress_tests::{ctx, reply};
use super::profile::Tool;
use serde_json::{Value, json};

const TARGET: NativeTarget = NativeTarget { pid: 1, window: 7 };
const CAPTURE: ReadShape = ReadShape {
    screenshot: true,
    tree: false,
};
const TREE: ReadShape = ReadShape {
    screenshot: false,
    tree: true,
};
const CAPTURE_ID: &str = "capture_abababababababababababababababab_000000000000000f";

fn state(extra: Value) -> Value {
    let mut payload = json!({"pid": 1, "window_id": 7, "app_name": "Notes", "window_title": "Todo",
        "screenshot_width": 800, "screenshot_height": 600, "screenshot_scale": 2.0,
        "screenshot_frame_valid": true, "capture_id": CAPTURE_ID, "snapshot_id": "s0000002a",
        "tree_markdown": "[1] button Secret", "_note": "x"});
    for (key, value) in extra.as_object().unwrap() {
        payload[key] = value.clone();
    }
    payload
}

/// PNG signature + IHDR for 800x600, matching `state()`'s claimed size.
const PNG_800X600: &str = "iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYCAYAAACadoJw";
const PNG_801X600: &str = "iVBORw0KGgoAAAANSUhEUgAAAyEAAAJYCAYAAAB1tOlO";

fn png(count: usize) -> Vec<Value> {
    vec![json!({"type": "image", "mimeType": "image/png", "data": PNG_800X600}); count]
}

fn read(
    shape: ReadShape,
    structured: Value,
    images: Vec<Value>,
) -> Result<Projection, EgressRefusal> {
    let mut content = vec![json!({"type": "text", "text": "Notes window with Secret tab"})];
    content.extend(images);
    let bytes = reply(json!({"content": content, "structuredContent": structured}));
    project(
        Tool::GetWindowState,
        &bytes,
        &ctx(Some(TARGET), Some(shape)),
    )
}

#[test]
fn a_qualified_capture_of_the_stamped_target_projects_its_image() {
    let Projection::WindowState(view) = read(CAPTURE, state(json!({})), png(1)).unwrap() else {
        panic!("not a window state");
    };
    assert_eq!((view.pid, view.window_id), (1, 7));
    assert_eq!(view.capture_id.as_deref(), Some(CAPTURE_ID));
    let image = view.image.unwrap();
    assert_eq!(
        (image.mime, image.width, image.height),
        ("image/png", 800, 600)
    );
    assert!(view.elements.is_empty());
}

#[test]
fn identity_policy_and_provenance_must_all_hold() {
    for (structured, refusal) in [
        (
            state(json!({"window_id": 8})),
            EgressRefusal::TargetMismatch,
        ),
        (state(json!({"pid": 2})), EgressRefusal::TargetMismatch),
        (
            state(json!({"screenshot_frame_valid": false})),
            EgressRefusal::ProvenanceUnproven,
        ),
        (
            state(json!({"screenshot_frame_valid": null})),
            EgressRefusal::ProvenanceUnproven,
        ),
        (
            state(json!({"screenshot_frame_valid": "true"})),
            EgressRefusal::ProvenanceUnproven,
        ),
        (
            state(json!({"screenshot_width": null})),
            EgressRefusal::ProvenanceUnproven,
        ),
        (
            state(json!({"capture_id": "capture_ABAB"})),
            EgressRefusal::Malformed,
        ),
    ] {
        assert_eq!(read(CAPTURE, structured, png(1)), Err(refusal));
    }
    assert_eq!(
        read(CAPTURE, state(json!({})), png(2)),
        Err(EgressRefusal::ProvenanceUnproven)
    );
    assert_eq!(
        read(CAPTURE, state(json!({})), png(0)),
        Err(EgressRefusal::ProvenanceUnproven)
    );
    let jpeg = vec![json!({"type": "image", "mimeType": "image/jpeg", "data": "AAAA"})];
    assert_eq!(
        read(CAPTURE, state(json!({})), jpeg),
        Err(EgressRefusal::ProvenanceUnproven)
    );
    // The claimed size must be the PNG's own; a bare signature proves nothing.
    for data in [
        PNG_801X600,
        "iVBORw0KGgo=",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let image = vec![json!({"type": "image", "mimeType": "image/png", "data": data})];
        assert_eq!(
            read(CAPTURE, state(json!({})), image),
            Err(EgressRefusal::ProvenanceUnproven),
            "{data}"
        );
    }
    // A screenshot without its registered capture id cannot ground a click.
    assert_eq!(
        read(CAPTURE, state(json!({"capture_id": null})), png(1)),
        Err(EgressRefusal::ProvenanceUnproven)
    );
    // The target's application became disallowed between dispatch and egress.
    let mut moved = TARGET;
    moved.pid = 12;
    let bytes = reply(json!({"content": png(1), "structuredContent": state(json!({"pid": 12}))}));
    let refusal = project(
        Tool::GetWindowState,
        &bytes,
        &ctx(Some(moved), Some(CAPTURE)),
    )
    .unwrap_err();
    assert_eq!(refusal.code(), "app_disallowed");
    // The upstream image-result fixture names no target: never projected.
    let fixture = include_str!(
        "../../../../../scripts/fixtures/cua-driver/0.38.0/contract-fixtures/image-result.json"
    );
    let mut fixture: Value = serde_json::from_str(fixture).unwrap();
    let bytes = reply(fixture["result"].take());
    assert_eq!(
        project(
            Tool::GetWindowState,
            &bytes,
            &ctx(Some(TARGET), Some(CAPTURE))
        ),
        Err(EgressRefusal::TargetMismatch)
    );
}

#[test]
fn tree_reads_keep_allowlisted_element_fields_only() {
    let elements = json!([
        {"element_index": 1, "role": "AXButton", "label": "Save", "depth": 2, "parent_index": 0,
         "enabled": true, "frame": {"x": 1, "y": 2, "w": 3, "h": 4}, "element_token": "s0000002a:1",
         "actions": ["AXPress"], "in_web_content": false, "value_description": "x"},
        {"element_index": 2, "role": "AXTextField", "value": "draft", "depth": 3},
    ]);
    let Projection::WindowState(view) = read(
        TREE,
        state(json!({"elements": elements, "truncated": true})),
        vec![],
    )
    .unwrap() else {
        panic!("not a window state");
    };
    assert!(view.image.is_none() && view.truncated);
    assert_eq!(view.elements.len(), 2);
    assert_eq!(view.elements[0].frame, Some([1.0, 2.0, 3.0, 4.0]));
    assert_eq!(
        view.elements[0].element_token.as_deref(),
        Some("s0000002a:1")
    );
    assert_eq!(view.elements[1].value.as_deref(), Some("draft"));
    for bad in [
        json!([{"element_index": 1, "role": "AXButton", "depth": 0, "element_token": "s2a:1"}]),
        // A token from another snapshot, and a mistyped parent index.
        json!([{"element_index": 1, "role": "AXButton", "depth": 0, "element_token": "s0000002b:1"}]),
        json!([{"element_index": 1, "role": "AXButton", "depth": 0, "parent_index": "0"}]),
        json!([{"role": "AXButton", "depth": 0}]),
        Value::Array(vec![
            json!({"element_index": 1, "role": "r", "depth": 0});
            251
        ]),
    ] {
        assert_eq!(
            read(TREE, state(json!({"elements": bad})), vec![]),
            Err(EgressRefusal::Malformed)
        );
    }
    // A tree-only read never returns pixels it did not ask for.
    assert_eq!(
        read(TREE, state(json!({"elements": []})), png(1)),
        Err(EgressRefusal::Malformed)
    );
    let failed = reply(json!({"content": [], "isError": true}));
    let refusal = project(
        Tool::GetWindowState,
        &failed,
        &ctx(Some(TARGET), Some(TREE)),
    )
    .unwrap_err();
    assert_eq!(refusal.code(), "target_stale");
}
