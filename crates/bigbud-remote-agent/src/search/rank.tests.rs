//! Runs the shared fuzzy-ranking fixtures that `packages/shared/src/search/nameRank.test.ts`
//! also runs, so the engine (remote and other projects) and Mod+P's local list rank identically.

use serde_json::Value;

use super::{RankedEntries, normalize_query, score_entry};
use crate::workspace::DirectoryEntry;

const FIXTURES: &str =
    include_str!("../../../../packages/shared/src/search/nameRank.fixtures.json");

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture field {key} is a string"))
        .to_owned()
}

fn rank(case: &Value) -> Vec<(String, u64)> {
    let query = normalize_query(&text(case, "query"));
    let limit = case["limit"].as_u64().expect("fixture limit") as usize;
    let mut ranked = RankedEntries::new(limit);
    for entry in case["entries"].as_array().expect("fixture entries") {
        let is_directory = text(entry, "kind") == "directory";
        let candidate = DirectoryEntry {
            path: text(entry, "path"),
            is_directory,
            is_file: !is_directory,
            size_bytes: 0,
            modified_unix_ms: 0,
        };
        if let Some(score) = score_entry(&candidate, &query) {
            ranked.insert(candidate, score);
        }
    }
    ranked
        .into_scored_entries()
        .into_iter()
        .map(|(score, entry)| (entry.path, score as u64))
        .collect()
}

#[test]
fn shared_name_rank_fixtures_match_the_typescript_ranker() {
    let fixtures: Value = serde_json::from_str(FIXTURES).expect("fixtures are JSON");
    let cases = fixtures["cases"].as_array().expect("fixture cases");
    assert!(cases.len() >= 9);
    for case in cases {
        let expected: Vec<(String, u64)> = case["expected"]
            .as_array()
            .expect("fixture expectations")
            .iter()
            .map(|hit| (text(hit, "path"), hit["score"].as_u64().expect("score")))
            .collect();
        assert_eq!(rank(case), expected, "{}", text(case, "name"));
    }
}

#[test]
fn trims_like_javascript() {
    assert_eq!(normalize_query("\u{feff}\u{3000} Main\u{2029}"), "main");
    assert_eq!(normalize_query("\u{85}main"), "\u{85}main");
}
