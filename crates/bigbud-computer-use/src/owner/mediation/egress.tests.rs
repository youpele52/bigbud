#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
use super::dispatch::NativeTarget;
use super::dispatch::{Dispatch, ObservationFrame, Stamps};
use super::egress::{
    AppPolicy, AppVerdict, Authority, EgressContext, EgressRefusal, FocusReport, Projection,
    ReadShape, WindowView, project,
};
use super::profile::Tool;
use super::response::ResponseRefusal;
use super::ticket::{Admitted, Delivery, Ticket};
use serde_json::{Value, json};

pub(super) struct Policy;
impl AppPolicy for Policy {
    fn verdict(&self, pid: u32) -> AppVerdict {
        match pid {
            // pid 0 is adversarially "permitted": egress must never ask.
            0..=9 => AppVerdict::Permitted,
            10..=19 => AppVerdict::Disallowed,
            _ => AppVerdict::Unverified,
        }
    }
}

const WIRE_ID: u64 = 41;
const AUTHORITY: Authority = Authority {
    policy_revision: 3,
    pause_epoch: 7,
};

pub(super) fn ctx(target: Option<NativeTarget>, read: Option<ReadShape>) -> EgressContext<'static> {
    EgressContext {
        wire_id: WIRE_ID,
        admitted: AUTHORITY,
        current: AUTHORITY,
        policy: &Policy,
        target,
        read,
    }
}

pub(super) fn reply(result: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": WIRE_ID, "result": result})).unwrap()
}

fn window(pid: Value, id: u64, z: Value) -> Value {
    json!({"window_id": id, "pid": pid, "app_name": format!("App {id}"), "title": format!("T{id}"),
        "bounds": {"x": 1, "y": 2, "width": 3, "height": 4}, "is_on_screen": true, "z_index": z,
        "layer": 0, "space_ids": [1], "current_space_id": 1, "on_current_space": true})
}

#[test]
fn window_discovery_keeps_only_permitted_records_and_reranks_stacking() {
    let windows = json!({"current_space_id": 1, "windows": [
        window(json!(1), 100, json!(10)),
        window(json!(10), 101, json!(9)),   // disallowed
        window(json!(2), 102, json!(5)),
        window(json!(null), 103, json!(4)), // ownership unknown
        window(json!(42), 104, json!(3)),   // unverified identity
        window(json!(0), 106, json!(11)),   // pid 0 names no process
        window(json!(3), 105, json!(null)),
        // A malformed excluded record cannot change the outcome.
        {"pid": 11, "garbage": true},
    ]});
    let bytes = reply(
        json!({"content": [{"type": "text", "text": "6 windows incl. Secret"}],
        "structuredContent": windows}),
    );
    let Projection::Windows(views) = project(Tool::ListWindows, &bytes, &ctx(None, None)).unwrap()
    else {
        panic!("not windows");
    };
    let expected = |pid: u32, id: u64, stack: Option<u32>| WindowView {
        pid,
        window_id: id,
        app_name: format!("App {id}"),
        title: format!("T{id}"),
        bounds: [1.0, 2.0, 3.0, 4.0],
        on_screen: true,
        stack,
    };
    // z 10 and 5 become dense ranks 1 and 0: the gaps left by excluded
    // windows (9, 4, 3) are not observable.
    assert_eq!(
        views,
        vec![
            expected(1, 100, Some(1)),
            expected(2, 102, Some(0)),
            expected(3, 105, None)
        ]
    );
}

#[test]
fn app_discovery_filters_and_malformed_permitted_records_refuse() {
    let apps = json!({"apps": [
        {"pid": 1, "name": "Notes", "running": true, "active": false, "bundle_id": "com.apple.Notes"},
        {"pid": 12, "name": "Secret", "running": true, "active": true, "bundle_id": "x.secret"},
        {"pid": 2, "name": "Calc", "running": true, "active": true, "bundle_id": null, "launch_path": "/x"},
        // Installed but not running: upstream reports pid 0, which names no
        // app, so it is dropped even though this policy "permits" pid 0.
        {"pid": 0, "name": "Slack", "running": false, "active": false, "bundle_id": "com.tinyspeck.slackmacgap"},
        {"pid": 3, "name": "Stale", "running": false, "active": false},
        {"pid": 4, "name": "Odd", "running": "yes", "active": false},
    ]});
    let bytes = reply(json!({"content": [], "structuredContent": apps}));
    let Projection::Apps(views) = project(Tool::ListApps, &bytes, &ctx(None, None)).unwrap() else {
        panic!("not apps");
    };
    let names: Vec<_> = views
        .iter()
        .map(|app| (app.name.as_str(), app.bundle_id.as_deref()))
        .collect();
    assert_eq!(
        names,
        vec![("Notes", Some("com.apple.Notes")), ("Calc", None)]
    );
    let bad = reply(
        json!({"content": [], "structuredContent": {"apps": [{"pid": 1, "running": true, "name": 5}]}}),
    );
    assert_eq!(
        project(Tool::ListApps, &bad, &ctx(None, None)),
        Err(EgressRefusal::Malformed)
    );
    let oversized: Vec<Value> = (0..1025).map(|_| json!({"pid": 99})).collect();
    let bytes = reply(json!({"content": [], "structuredContent": {"apps": oversized}}));
    assert_eq!(
        project(Tool::ListApps, &bytes, &ctx(None, None)),
        Err(EgressRefusal::Malformed)
    );
}

#[test]
fn reads_are_withheld_after_policy_or_pause_changes_but_outcomes_are_not() {
    let bytes = reply(json!({"content": [], "structuredContent": {"apps": []}}));
    let mut moved = ctx(None, None);
    moved.current.pause_epoch += 1;
    assert_eq!(
        project(Tool::ListApps, &bytes, &moved).unwrap_err().code(),
        "paused"
    );
    let mut revised = ctx(None, None);
    revised.current.policy_revision += 1;
    assert_eq!(
        project(Tool::ListWindows, &bytes, &revised)
            .unwrap_err()
            .code(),
        "policy_pending"
    );
    let action = reply(
        json!({"content": [], "structuredContent": {"effect": "confirmed", "route": "accessibility"}}),
    );
    assert!(matches!(
        project(Tool::Click, &action, &revised),
        Ok(Projection::Action(_))
    ));
}

#[test]
fn failures_and_foreign_replies_are_content_free() {
    let failed = reply(
        json!({"content": [{"type": "text", "text": "Secret App crashed"}], "isError": true}),
    );
    let refusal = project(Tool::ListWindows, &failed, &ctx(None, None)).unwrap_err();
    assert_eq!(refusal, EgressRefusal::ReadFailed { targeted: false });
    assert_eq!(refusal.code(), "control_unavailable");
    // Another wire id, the caller's string id and a float spelling all miss.
    for id in [json!(42), json!("op-1.1"), json!("41"), json!(41.0)] {
        let foreign =
            serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": id, "result": {"content": []}}))
                .unwrap();
        assert_eq!(
            project(Tool::ListApps, &foreign, &ctx(None, None)),
            Err(EgressRefusal::Response(ResponseRefusal::IdMismatch)),
            "{id}"
        );
    }
    let error = serde_json::to_vec(
        &json!({"jsonrpc": "2.0", "id": WIRE_ID, "error": {"code": -32000, "message": "Secret"}}),
    )
    .unwrap();
    assert_eq!(
        project(Tool::ListApps, &error, &ctx(None, None))
            .unwrap_err()
            .code(),
        "control_unavailable"
    );
    let both = serde_json::to_vec(
        &json!({"jsonrpc": "2.0", "id": WIRE_ID, "result": {"content": []}, "error": {}}),
    )
    .unwrap();
    assert_eq!(
        project(Tool::ListApps, &both, &ctx(None, None)),
        Err(EgressRefusal::Response(ResponseRefusal::Shape))
    );
}

#[test]
fn metadata_tools_keep_only_bounded_status() {
    let permissions = reply(
        json!({"content": [], "structuredContent": {"accessibility": true,
        "screen_recording": false, "source": {"path": "/Applications/Secret.app"}, "direct_capture_error": "x"}}),
    );
    assert_eq!(
        project(Tool::CheckPermissions, &permissions, &ctx(None, None)),
        Ok(Projection::Permissions {
            accessibility: true,
            screen_recording: false
        })
    );
    let health = reply(
        json!({"content": [], "structuredContent": {"schema_version": "1", "overall": "degraded",
        "checks": [{"name": "tcc_accessibility", "status": "pass", "message": "m", "data": {"p": "/x"}},
                   {"name": "screen_capture_capability", "status": "skip", "hint": "h"}]}}),
    );
    let Projection::Health(view) = project(Tool::HealthReport, &health, &ctx(None, None)).unwrap()
    else {
        panic!("not health");
    };
    assert_eq!(view.overall, "degraded");
    assert_eq!(
        view.checks,
        vec![
            ("tcc_accessibility".into(), "pass"),
            ("screen_capture_capability".into(), "skip")
        ]
    );
    let bad = reply(
        json!({"content": [], "structuredContent": {"overall": "ok", "checks": [{"name": "Bad Name", "status": "pass"}]}}),
    );
    assert_eq!(
        project(Tool::HealthReport, &bad, &ctx(None, None)),
        Err(EgressRefusal::Malformed)
    );
    // bring_to_front is a mutation: its report is never authoritative and
    // never refused away (native verify_foreground decides).
    for (bytes, report) in [
        (reply(json!({"content": []})), FocusReport::Reported),
        (
            reply(json!({"content": [], "isError": true})),
            FocusReport::Refused,
        ),
        (b"not json".to_vec(), FocusReport::Unknown),
    ] {
        assert_eq!(
            project(Tool::BringToFront, &bytes, &ctx(None, None)),
            Ok(Projection::Focus(report))
        );
    }
}

#[test]
fn egress_matches_the_wire_id_dispatch_assigned() {
    let ticket = Ticket {
        admitted: Admitted::ListApps,
        delivery: Delivery::Background,
        capture_after: false,
    };
    let stamps = Stamps {
        session: "c1",
        target: None,
        observation: None::<ObservationFrame<'_>>,
    };
    let request = json!({"jsonrpc": "2.0", "id": "op-1.1", "method": "tools/call",
        "params": {"name": "list_apps", "arguments": {}}});
    let forwarded = Dispatch::new(ticket)
        .unwrap()
        .forward(&serde_json::to_vec(&request).unwrap(), &stamps, WIRE_ID)
        .unwrap();
    let sent: Value = serde_json::from_slice(&forwarded.bytes).unwrap();
    let answer = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": sent["id"],
        "result": {"content": [], "structuredContent": {"apps": []}}}))
    .unwrap();
    assert_eq!(
        project(Tool::ListApps, &answer, &ctx(None, None)),
        Ok(Projection::Apps(vec![]))
    );
    assert_eq!(forwarded.caller_id, json!("op-1.1"));
}
