use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bigbud_protocol::v1;

use super::*;

pub(super) struct Fixture(pub(super) PathBuf);

impl Fixture {
    pub(super) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "bigbud-search-engine-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create search fixture: {error}"),
            }
        }
    }

    pub(super) fn write(&self, path: &str, contents: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().expect("fixture file has a parent")).unwrap();
        fs::write(path, contents).unwrap();
    }

    pub(super) fn root_string(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    pub(super) fn proto_request(
        &self,
        query: &str,
        mode: v1::WorkspaceSearchMode,
    ) -> v1::WorkspaceSearchRequest {
        v1::WorkspaceSearchRequest {
            request_id: "request-1".to_owned(),
            operation_id: "search-1".to_owned(),
            roots: vec![v1::WorkspaceSearchRoot {
                root_id: "root-a".to_owned(),
                root: self.root_string(),
                relative_path: String::new(),
            }],
            query: query.to_owned(),
            mode: mode as i32,
            ..Default::default()
        }
    }

    pub(super) fn request(&self, query: &str, mode: v1::WorkspaceSearchMode) -> SearchRequest {
        let (request, failures) =
            SearchRequest::from_proto(&self.proto_request(query, mode)).unwrap();
        assert!(failures.is_empty());
        request
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn request_validation_rejects_bad_input_and_clamps_limits() {
    let fixture = Fixture::new();
    let mut request = fixture.proto_request("needle", v1::WorkspaceSearchMode::Content);
    let check = |request: &v1::WorkspaceSearchRequest| SearchRequest::from_proto(request).err();

    request.query = "  ".to_owned();
    assert_eq!(check(&request), Some(SearchRequestError::EmptyQuery));
    request.query = "a\u{7}b".to_owned();
    assert_eq!(check(&request), Some(SearchRequestError::ControlCharacter));
    request.query = "x".repeat(513);
    assert_eq!(check(&request), Some(SearchRequestError::QueryTooLong));
    request.query = "needle".to_owned();
    request.mode = 0;
    assert_eq!(check(&request), Some(SearchRequestError::MissingMode));
    request.mode = v1::WorkspaceSearchMode::Content as i32;
    let template = request.roots[0].clone();
    request.roots = vec![template.clone(); MAX_SEARCH_ROOTS + 1];
    assert_eq!(check(&request), Some(SearchRequestError::TooManyRoots));
    assert_eq!(SearchRequestError::TooManyRoots.code(), "TOO_MANY_ROOTS");
    request.roots = Vec::new();
    assert_eq!(check(&request), Some(SearchRequestError::NoRoots));

    request.roots = vec![template];
    request.deadline_ms = 60_000;
    request.max_threads = 99;
    request.max_results = 50_000;
    request.priority = v1::WorkspaceSearchPriority::Background as i32;
    let (parsed, _) = SearchRequest::from_proto(&request).unwrap();
    assert_eq!(parsed.deadline, MAX_SEARCH_DEADLINE);
    assert_eq!(
        parsed.threads, 2,
        "background searches use at most two threads"
    );
    assert_eq!(parsed.max_results, crate::workspace::MAX_SEARCH_RESULTS);
    assert!(parsed.background);
    request.deadline_ms = 0;
    request.priority = v1::WorkspaceSearchPriority::Interactive as i32;
    let (parsed, _) = SearchRequest::from_proto(&request).unwrap();
    assert_eq!(parsed.deadline, Duration::from_secs(2));
    assert!((2..=6).contains(&parsed.threads));
}

#[test]
fn unopenable_roots_are_reported_per_root_while_others_run() {
    let fixture = Fixture::new();
    let mut request = fixture.proto_request("needle", v1::WorkspaceSearchMode::Content);
    request.roots.push(v1::WorkspaceSearchRoot {
        root_id: "missing".to_owned(),
        root: fixture.0.join("missing").to_string_lossy().into_owned(),
        relative_path: String::new(),
    });
    request.roots.push(v1::WorkspaceSearchRoot {
        root_id: "relative".to_owned(),
        root: "relative/root".to_owned(),
        relative_path: String::new(),
    });
    let (parsed, failures) = SearchRequest::from_proto(&request).unwrap();
    assert_eq!(parsed.roots.len(), 1);
    let failed: Vec<_> = failures
        .iter()
        .map(|failure| failure.root_id.as_str())
        .collect();
    assert_eq!(failed, ["missing", "relative"]);
}

#[test]
fn registry_limits_concurrency_cancels_by_operation_and_frees_slots_on_drop() {
    let registry = SearchRegistry::default();
    let first = registry.register("a").unwrap();
    assert_eq!(
        registry.register("a").unwrap_err(),
        SearchRegisterError::Duplicate
    );
    let second = registry.register("b").unwrap();
    assert_eq!(
        registry.register("c").unwrap_err(),
        SearchRegisterError::Busy
    );
    assert_eq!(SearchRegisterError::Busy.code(), "SEARCH_BUSY");
    assert_eq!(
        registry.register("").unwrap_err(),
        SearchRegisterError::MissingOperationId
    );

    assert!(registry.cancel("a"));
    assert!(first.cancel_flag().load(Ordering::Relaxed));
    assert!(!second.cancel_flag().load(Ordering::Relaxed));
    assert!(!registry.cancel("unknown"));
    drop(first);
    assert!(
        !registry.cancel("a"),
        "a dropped ticket leaves the registry"
    );
    assert_eq!(registry.len(), 1);
    registry.cancel_all();
    assert!(second.cancel_flag().load(Ordering::Relaxed));
    drop(second);
    assert!(registry.is_empty());
}

#[test]
fn background_priority_lowering_is_accepted_on_supported_platforms() {
    let accepted = std::thread::spawn(lower_current_thread_priority)
        .join()
        .unwrap();
    if cfg!(any(target_os = "macos", windows)) {
        assert!(accepted);
    }
}
