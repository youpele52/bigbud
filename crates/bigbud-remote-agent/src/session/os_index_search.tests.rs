use super::*;

fn ready_session(os_index: bool) -> (AgentSession, Vec<String>) {
    let mut session = AgentSession::with_epoch("epoch-1");
    if os_index {
        session.enable_os_index();
    }
    let capabilities = match session
        .handle(test_helpers::hello())
        .expect("hello")
        .payload
    {
        Some(v1::frame::Payload::AgentHello(hello)) => hello
            .capabilities
            .into_iter()
            .map(|capability| capability.name)
            .collect(),
        _ => panic!("expected agent hello"),
    };
    (session, capabilities)
}

fn request(scope_level: v1::OsIndexScopeLevel, query: &str) -> v1::OsIndexSearchRequest {
    v1::OsIndexSearchRequest {
        request_id: "request-1".to_owned(),
        operation_id: "os-index-1".to_owned(),
        query: query.to_owned(),
        scope_level: scope_level as i32,
        max_results: 50,
        deadline_ms: 700,
    }
}

fn refusal_code(frame: v1::Frame) -> String {
    match frame.payload {
        Some(v1::frame::Payload::OsIndexSearchCompleted(completed)) => {
            assert_eq!(completed.stop_reason, "error");
            assert_eq!(completed.operation_id, "os-index-1");
            assert!(!completed.error_message.contains("needle"));
            completed.error_code
        }
        other => panic!("expected an os index completion, got {other:?}"),
    }
}

#[test]
fn capability_is_advertised_only_for_the_desktop_local_agent() {
    let (_, plain) = ready_session(false);
    assert!(!plain.contains(&"os-index.search".to_owned()));
    assert!(plain.contains(&"workspace.search-stream".to_owned()));
    let (_, desktop) = ready_session(true);
    assert!(desktop.contains(&"os-index.search".to_owned()));
}

#[test]
fn agents_without_os_index_refuse_requests() {
    let (mut session, _) = ready_session(false);
    let refusal = session
        .prepare_os_index_search(request(v1::OsIndexScopeLevel::CommonFolders, "needle"))
        .err()
        .expect("refused");
    assert_eq!(refusal_code(*refusal), "UNSUPPORTED");
    assert!(session.os_index_registry().is_empty());
}

#[test]
fn the_generic_frame_handler_refuses_even_with_os_index_enabled() {
    // Supervisor connections and other modes reach `handle`; only the stdio branch of
    // `--ephemeral --os-index` may run a query.
    let (mut session, _) = ready_session(true);
    let frame = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::OsIndexSearchRequest(request(
                v1::OsIndexScopeLevel::Unrestricted,
                "needle",
            ))),
        })
        .expect("refusal frame");
    assert_eq!(refusal_code(frame), "UNSUPPORTED");
}

#[test]
fn requires_hello_and_a_scope_level() {
    let mut session = AgentSession::with_epoch("epoch-1");
    session.enable_os_index();
    let before_hello = session
        .prepare_os_index_search(request(v1::OsIndexScopeLevel::CommonFolders, "needle"))
        .err()
        .expect("refused");
    assert!(matches!(
        before_hello.payload,
        Some(v1::frame::Payload::ProtocolError(_))
    ));
    let (mut session, _) = ready_session(true);
    let refusal = session
        .prepare_os_index_search(request(v1::OsIndexScopeLevel::Unspecified, "needle"))
        .err()
        .expect("refused");
    assert_eq!(refusal_code(*refusal), "INVALID_ARGUMENT");
}

#[test]
fn cancel_request_reaches_a_registered_os_index_search() {
    let (mut session, _) = ready_session(true);
    let ticket = session
        .os_index_registry()
        .register("os-index-1")
        .expect("slot");
    let response = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::CancelRequest(v1::CancelRequest {
                request_id: "cancel-1".to_owned(),
                operation_id: "os-index-1".to_owned(),
            })),
        })
        .expect("cancel response");
    match response.payload {
        Some(v1::frame::Payload::CancelResponse(response)) => assert!(response.cancelled),
        other => panic!("expected cancel response, got {other:?}"),
    }
    assert!(
        ticket
            .cancel_flag()
            .load(std::sync::atomic::Ordering::Relaxed)
    );
}

#[test]
fn the_home_folder_comes_from_os_index_and_its_absence_is_refused() {
    let (mut session, _) = ready_session(true);
    let refusal = session
        .prepare_os_index_search_in(
            request(v1::OsIndexScopeLevel::CommonFolders, "needle"),
            None,
        )
        .err()
        .expect("refused");
    assert_eq!(
        refusal_code(*refusal),
        crate::os_index::OsIndexError::HomeUnavailable.code()
    );
    assert!(session.os_index_registry().is_empty());

    let home = std::env::temp_dir().join(format!(
        "bigbud-os-index-home-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    std::fs::create_dir_all(home.join("Documents")).expect("Documents");
    let prepared = session.prepare_os_index_search_in(
        request(v1::OsIndexScopeLevel::CommonFolders, "needle"),
        Some(home.clone()),
    );
    let _removed = std::fs::remove_dir_all(&home);
    let prepared = prepared.unwrap_or_else(|frame| panic!("prepared, got {frame:?}"));
    assert_eq!(prepared.operation_id(), "os-index-1");
}

#[cfg(windows)]
#[test]
fn windows_uses_the_user_profile_not_home() {
    // `HOME` is normally unset on Windows; `os_index::home_folder` reads `USERPROFILE`.
    assert_eq!(
        crate::os_index::home_folder(),
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
    );
}
