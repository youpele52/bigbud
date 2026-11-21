//! The hard limit with atomic eviction and close-all with `managed_only` (plan §8.8, §9.1).

use bigbud_protocol::pty_lifecycle::PTY_LIMIT_REACHED;

use super::super::super::pty_lifecycle_host::kind;
use super::super::super::*;
use super::fixture::Host;

fn visible(host: &Host, id: &str, visible: bool) {
    let frame = host
        .session
        .lock()
        .unwrap()
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::PtyViewStateRequest(Box::new(
                v1::PtyViewStateRequest {
                    request_id: "view".to_owned(),
                    pty_id: host.id(id),
                    view_state: if visible { "visible" } else { "hidden" }.to_owned(),
                    renderer_attached: true,
                    ..Default::default()
                },
            ))),
        })
        .unwrap();
    assert!(matches!(frame.payload,
        Some(v1::frame::Payload::PtyViewStateResponse(response)) if response.accepted));
}

#[test]
fn limit_eviction_is_atomic_and_never_takes_a_visible_or_unmanaged_pty() {
    let mut host = Host::new(false);
    host.policy(true, 2, 0);
    assert!(
        host.create(host.request("a", true, "/bin/sleep", &["30"]))
            .accepted
    );
    host.clock.advance(1_000);
    let b = host.create(host.request("b", true, "/bin/sleep", &["30"]));
    assert!(b.accepted);
    assert_eq!((b.limit, b.live_count), (2, 2));
    // Unmanaged PTYs never count and are never refused.
    assert!(
        host.create(host.request("u", false, "/bin/sleep", &["30"]))
            .accepted
    );

    let refused = host.create(host.request("c", true, "/bin/sleep", &["30"]));
    assert!(!refused.accepted);
    assert_eq!(refused.error_code, PTY_LIMIT_REACHED);
    assert_eq!((refused.limit, refused.live_count), (2, 2));
    assert_eq!(
        refused.eviction_candidate_pty_id,
        host.id("a"),
        "least recently used"
    );

    // A visible candidate is refused, with a fresh candidate instead.
    visible(&host, "a", true);
    let mut request = host.request("c", true, "/bin/sleep", &["30"]);
    request.evict_pty_id = host.id("a");
    let refused = host.create(request.clone());
    assert!(!refused.accepted);
    assert_eq!(refused.eviction_candidate_pty_id, host.id("b"));
    assert!(host.lifecycle("a").handle().is_running());

    // An unmanaged candidate is never evicted either.
    request.evict_pty_id = host.id("u");
    assert!(!host.create(request.clone()).accepted);
    assert!(host.lifecycle("u").handle().is_running());

    visible(&host, "a", false);
    request.evict_pty_id = host.id("a");
    let admitted = host.create(request);
    assert!(admitted.accepted, "{admitted:?}");
    assert_eq!(admitted.evicted_pty_id, host.id("a"));
    assert!(host.wait_notice("a", kind::LIMIT_CLOSED));
    assert!(!host.lifecycle("a").handle().is_running());
    assert!(host.lifecycle("c").handle().is_running());
}

#[test]
fn close_all_with_managed_only_leaves_unmanaged_and_old_client_ptys_running() {
    let mut host = Host::new(false);
    host.create(host.request("managed", true, "/bin/sleep", &["30"]));
    host.create(host.request("unmanaged", false, "/bin/sleep", &["30"]));
    let mut legacy = host.request("legacy", false, "/bin/sleep", &["30"]);
    legacy.screen_scrollback_rows = 0;
    host.create(legacy);
    let legacy_handle = host
        .session
        .lock()
        .unwrap()
        .pty_operation_handle(&host.id("legacy"))
        .unwrap();
    assert!(
        host.session
            .lock()
            .unwrap()
            .pty_lifecycle(&host.id("legacy"))
            .is_err()
    );

    let prepared = host
        .session
        .lock()
        .unwrap()
        .prepare_close_all(v1::PtyCloseAllRequest {
            request_id: "quit".to_owned(),
            reason: "quit".to_owned(),
            managed_only: true,
        });
    let (frame, closed) = prepared.execute();
    assert_eq!(closed, vec![host.id("managed")]);
    assert!(matches!(frame.payload,
        Some(v1::frame::Payload::PtyCloseAllResponse(response))
            if response.accepted && response.closed_count == 1));
    assert!(host.wait_notice("managed", kind::QUIT_CLOSED));
    assert!(host.lifecycle("unmanaged").handle().is_running());
    assert!(legacy_handle.is_running());

    let prepared = host
        .session
        .lock()
        .unwrap()
        .prepare_close_all(v1::PtyCloseAllRequest {
            request_id: "update".to_owned(),
            reason: "update".to_owned(),
            managed_only: false,
        });
    let (_, closed) = prepared.execute();
    assert_eq!(closed.len(), 2);
    assert!(!legacy_handle.is_running());
}
