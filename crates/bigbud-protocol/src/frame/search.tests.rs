use crate::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};

fn golden(name: &str) -> Vec<u8> {
    let (_, hex) = include_str!("../../../../protocol/remote-agent/v1.golden.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| *key == name)
        .expect("shared search golden exists");
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex byte")
        })
        .collect()
}

#[test]
fn search_frames_match_shared_typescript_goldens() {
    let frames = [
        (
            "workspace_search_request",
            v1::frame::Payload::WorkspaceSearchRequest(v1::WorkspaceSearchRequest {
                request_id: "search-1".to_owned(),
                operation_id: "op-1".to_owned(),
                roots: vec![
                    v1::WorkspaceSearchRoot {
                        root_id: "project-a".to_owned(),
                        root: "/home/dev/app".to_owned(),
                        relative_path: String::new(),
                    },
                    v1::WorkspaceSearchRoot {
                        root_id: "project-b".to_owned(),
                        root: "/home/dev/lib".to_owned(),
                        relative_path: "src".to_owned(),
                    },
                ],
                query: "needle".to_owned(),
                mode: v1::WorkspaceSearchMode::Both as i32,
                max_results: 200,
                max_results_per_root: 20,
                deadline_ms: 3_000,
                max_threads: 2,
                priority: v1::WorkspaceSearchPriority::Background as i32,
            }),
        ),
        (
            "workspace_search_batch",
            v1::frame::Payload::WorkspaceSearchBatch(v1::WorkspaceSearchBatch {
                request_id: "search-1".to_owned(),
                operation_id: "op-1".to_owned(),
                sequence: 1,
                names: vec![v1::WorkspaceSearchNameHit {
                    root_id: "project-a".to_owned(),
                    path: "src/needle.ts".to_owned(),
                    is_directory: false,
                    size_bytes: 1_024,
                    modified_unix_ms: 1_763_500_000_000,
                    score: 2,
                }],
                contents: vec![v1::WorkspaceSearchContentHit {
                    root_id: "project-a".to_owned(),
                    path: "src/a.ts".to_owned(),
                    line: 12,
                    column: 5,
                    excerpt: "const needle = 1;".to_owned(),
                }],
            }),
        ),
        (
            "workspace_search_completed",
            v1::frame::Payload::WorkspaceSearchCompleted(v1::WorkspaceSearchCompleted {
                request_id: "search-1".to_owned(),
                operation_id: "op-1".to_owned(),
                stop_reason: "deadline".to_owned(),
                truncated: true,
                files_scanned: 14_421,
                root_errors: vec![v1::WorkspaceSearchRootError {
                    root_id: "project-b".to_owned(),
                    error_code: "NOT_FOUND".to_owned(),
                }],
                batches: 3,
                ..Default::default()
            }),
        ),
        (
            "os_index_search_request",
            v1::frame::Payload::OsIndexSearchRequest(v1::OsIndexSearchRequest {
                request_id: "os-1".to_owned(),
                operation_id: "op-os-1".to_owned(),
                query: "invoice".to_owned(),
                scope_level: v1::OsIndexScopeLevel::CommonFolders as i32,
                max_results: 50,
                deadline_ms: 700,
            }),
        ),
        (
            "os_index_search_batch",
            v1::frame::Payload::OsIndexSearchBatch(v1::OsIndexSearchBatch {
                request_id: "os-1".to_owned(),
                operation_id: "op-os-1".to_owned(),
                sequence: 1,
                hits: vec![v1::OsIndexSearchHit {
                    path: "/Users/dev/Documents/invoice.pdf".to_owned(),
                    is_directory: false,
                    content_type: "com.adobe.pdf".to_owned(),
                    size_bytes: 52_000,
                    modified_unix_ms: 1_763_500_000_000,
                    last_used_unix_ms: 1_763_600_000_000,
                    score: 3,
                }],
            }),
        ),
        (
            "os_index_search_completed",
            v1::frame::Payload::OsIndexSearchCompleted(v1::OsIndexSearchCompleted {
                request_id: "os-1".to_owned(),
                operation_id: "op-os-1".to_owned(),
                stop_reason: "complete".to_owned(),
                source: "spotlight".to_owned(),
                availability: "ready".to_owned(),
                excluded: 2,
                batches: 1,
                ..Default::default()
            }),
        ),
    ];
    for (name, payload) in frames {
        let frame = v1::Frame {
            payload: Some(payload),
        };
        let bytes = golden(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            bytes,
            "{name}"
        );
        assert_eq!(
            decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame,
            "{name}"
        );
    }
}
