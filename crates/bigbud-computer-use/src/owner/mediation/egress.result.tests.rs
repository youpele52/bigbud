#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
use super::egress::{ActionView, Projection, project};
use super::egress_tests::{ctx, reply};
use super::profile::Tool;
use serde_json::{Value, json};

fn action(bytes: &[u8]) -> ActionView {
    match project(Tool::Click, bytes, &ctx(None, None)) {
        Ok(Projection::Action(view)) => view,
        other => panic!("{other:?}"),
    }
}

fn structured(result: Value) -> ActionView {
    action(&reply(
        json!({"content": [{"type": "text", "text": "clicked Secret"}], "structuredContent": result}),
    ))
}

#[test]
fn action_results_keep_only_the_closed_enums() {
    let view = structured(json!({"effect": "partial", "route": "synthetic_events",
        "delivery": {"mode": "background", "delivered_count": 2},
        "escalation": {"target": "foreground", "reason": "delivery_failed"},
        "evidence": [{"kind": "window_change", "detail": "Secret window opened"}],
        "error": {"code": "partial_delivery", "hint": "retry in Secret"},
        "summary": "Clicked Secret", "hint": "h", "next_call": {"tool": "kill_app", "arguments": {}}}));
    assert_eq!(
        view,
        ActionView {
            effect: Some("partial"),
            route: Some("synthetic_events"),
            delivery_mode: Some("background"),
            delivered_count: Some(2),
            error_code: Some("partial_delivery".into()),
            escalation: Some(("foreground", "delivery_failed")),
            evidence: vec!["window_change"],
        }
    );
}

#[test]
fn any_doubt_makes_completion_unknown_never_not_started() {
    for bad in [
        json!({"effect": "done", "route": "accessibility"}),
        json!({"effect": "confirmed"}),
        json!({"effect": "confirmed", "route": "accessibility", "delivery": {"mode": "teleport"}}),
        json!({"effect": "confirmed", "route": "accessibility", "evidence": [{"kind": "screenshot"}]}),
        json!({"effect": "confirmed", "route": "accessibility", "delivery": {"mode": "foreground", "delivered_count": -1}}),
        // The pinned ActionResult is closed: an unknown key distrusts it.
        json!({"effect": "confirmed", "route": "accessibility", "secret_title": "Secret"}),
    ] {
        assert_eq!(structured(bad.clone()), ActionView::default(), "{bad}");
    }
    assert_eq!(action(b"not json"), ActionView::default());
    assert_eq!(
        action(&reply(json!({"content": [], "isError": true}))),
        ActionView::default()
    );
    // A diagnostic envelope keeps only its machine code; completion unknown.
    let diagnostic = structured(json!({"code": "tool_invocation_failed", "exit_code": 1}));
    assert_eq!(
        (diagnostic.effect, diagnostic.error_code.as_deref()),
        (None, Some("tool_invocation_failed"))
    );
}

#[test]
fn refusals_keep_a_machine_code_and_drop_prose() {
    let fixture = include_str!(
        "../../../../../scripts/fixtures/cua-driver/0.38.0/contract-fixtures/tool-refusal.json"
    );
    let mut fixture: Value = serde_json::from_str(fixture).unwrap();
    let view = action(&reply(fixture["result"].take()));
    assert_eq!(view.effect, Some("refused"));
    assert_eq!(view.error_code.as_deref(), Some("foreground_required"));
    let prose = structured(json!({"effect": "refused", "route": "accessibility",
        "error": {"code": "Secret App is frontmost"}}));
    assert_eq!(
        prose,
        ActionView::default(),
        "prose in a code field distrusts the result"
    );
    // "Not started" needs the whole envelope: isError, status and an ident
    // code. Prose, punctuation, over-long or missing codes make it unknown.
    let envelope = |refusal: Value, is_error: bool| {
        action(&reply(json!({"content": [], "isError": is_error,
            "structuredContent": {"status": "refused", "refusal": refusal}})))
    };
    for refusal in [
        json!({"code": "Window of Secret"}),
        json!({"code": "secret app is frontmost"}),
        json!({"code": "path=/users/secret"}),
        json!({"code": "a".repeat(65)}),
        json!({}),
        json!("foreground_required"),
    ] {
        assert_eq!(
            envelope(refusal.clone(), true),
            ActionView::default(),
            "{refusal}"
        );
    }
    let code = json!({"code": "target_stale_2"});
    assert_eq!(envelope(code.clone(), false), ActionView::default());
    let kept = envelope(code, true);
    assert_eq!(
        (kept.effect, kept.error_code.as_deref()),
        (Some("refused"), Some("target_stale_2"))
    );
}
