use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "bigbud-name-search-{}-{}",
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

    fn file(&self, path: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "needle\nNeedle\n").unwrap();
    }

    fn workspace(&self) -> WorkspaceRoot {
        WorkspaceRoot::open(&self.0).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn filename_search_matches_uppercase_full_paths_and_fuzzy_queries() {
    let root = Fixture::new();
    root.file("src/Layout/CommandPalette.tsx");
    let workspace = root.workspace();
    for query in [
        "commandpalette",
        "COMMANDPALETTE",
        "layout/command",
        "src/layout/commandpalette.tsx",
        "cmdplt",
        "s/l/cp",
        "  @./SRC/LAYOUT/COMMANDPALETTE.TSX  ",
    ] {
        assert_eq!(
            workspace.search_names("", query, 10).unwrap(),
            vec!["src/Layout/CommandPalette.tsx"],
            "query: {query}"
        );
    }
    assert_eq!(
        workspace
            .search_names("src/Layout", "src/layout/command", 10)
            .unwrap(),
        vec!["src/Layout/CommandPalette.tsx"]
    );
    assert!(workspace.search_names("", "zzzz", 10).unwrap().is_empty());
}

fn candidate(path: &str, is_directory: bool) -> DirectoryEntry {
    DirectoryEntry {
        path: path.to_owned(),
        is_directory,
        is_file: !is_directory,
        size_bytes: 0,
        modified_unix_ms: 0,
    }
}

#[test]
fn scoring_matches_existing_exact_prefix_substring_and_fuzzy_priorities() {
    for (path, query, expected) in [
        ("src/MAIN", "main", 0),
        ("src/main", "src/main", 1),
        ("src/main.rs", "main", 2),
        ("src/main.rs", "src/ma", 3),
        ("src/main.rs", "main.rs/", usize::MAX),
        ("src/main.rs", "main.rs", 0),
        ("lib/main/file.rs", "main/", 4),
        ("src/domain.rs", "main", 5),
        ("lib/domain/file.rs", "main/", 6),
        ("abxc", "abc", 105),
        ("a/b/c", "abc", 210),
        ("😀abxc", "abc", 111),
    ] {
        let expected = (expected != usize::MAX).then_some(expected);
        assert_eq!(
            rank::score_entry(&candidate(path, false), query),
            expected,
            "{path}: {query}"
        );
    }
}

#[test]
fn filename_search_ranks_before_limit_instead_of_stopping_at_early_matches() {
    let root = Fixture::new();
    for path in ["main-extra.rs", "amain.rs", "nested/main", "main"] {
        root.file(path);
    }
    let workspace = root.workspace();
    assert_eq!(
        workspace.search_names("", "main", 3).unwrap(),
        vec!["main", "nested/main", "main-extra.rs"]
    );
    assert_eq!(workspace.search_names("", "main", 1).unwrap(), vec!["main"]);
}

#[test]
fn bounded_ranking_replaces_worse_candidates_and_breaks_ties_by_path() {
    let mut ranked = rank::RankedEntries::new(2);
    for (path, score) in [("worst", 200), ("z", 2), ("a", 2), ("best", 0)] {
        ranked.insert(candidate(path, false), score);
    }
    assert_eq!(
        ranked
            .into_entries()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>(),
        vec!["best", "a"]
    );
    let mut empty = rank::RankedEntries::new(0);
    empty.insert(candidate("file", false), 0);
    assert!(empty.into_entries().is_empty());
}

#[test]
fn normalized_empty_queries_rank_directories_first_and_raw_empty_still_errors() {
    let root = Fixture::new();
    root.file("afile");
    fs::create_dir(root.0.join("zdir")).unwrap();
    let workspace = root.workspace();
    for query in ["   ", "@./"] {
        assert_eq!(
            workspace.search_names("", query, 10).unwrap(),
            vec!["zdir", "afile"]
        );
    }
    assert!(matches!(
        workspace.search_entries("", "", 10),
        Err(WorkspaceError::EmptySearchQuery)
    ));
    assert!(workspace.search_names("", "file", 0).unwrap().is_empty());
}

#[test]
fn filename_search_clamps_requested_result_count() {
    let root = Fixture::new();
    for index in 0..MAX_SEARCH_RESULTS + 3 {
        root.file(&format!("file-{index:04}"));
    }
    let results = root
        .workspace()
        .search_names("", "file", usize::MAX)
        .unwrap();
    assert_eq!(results.len(), MAX_SEARCH_RESULTS);
    assert_eq!(results.first().unwrap(), "file-0000");
    assert_eq!(results.last().unwrap(), "file-0999");
}

#[test]
fn filename_search_bounds_all_entries_even_without_matches_or_with_small_result_limit() {
    let root = Fixture::new();
    for name in ["a", "b", "c"] {
        root.file(name);
    }
    let workspace = root.workspace();
    for query in ["@", "no-match"] {
        assert!(matches!(
            workspace.search_entries_bounded("", query, 1, 2),
            Err(WorkspaceError::SearchLimitExceeded)
        ));
        assert!(workspace.search_entries_bounded("", query, 1, 3).is_ok());
    }
}

#[test]
fn filename_search_bounds_directory_frontier_and_ignored_entries() {
    let root = Fixture::new();
    for name in ["a", "b", "node_modules"] {
        fs::create_dir(root.0.join(name)).unwrap();
    }
    root.file("node_modules/hidden");
    let workspace = root.workspace();
    assert!(matches!(
        workspace.search_entries_bounded("", "no-match", 1, 2),
        Err(WorkspaceError::SearchLimitExceeded)
    ));
    assert!(
        workspace
            .search_entries_bounded("", "no-match", 1, 3)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn filename_search_rejects_explicit_unsafe_roots_even_with_zero_results() {
    let root = Fixture::new();
    root.file("file");
    let workspace = root.workspace();
    for path in ["../", "nested/../../", "/", "a\0b", "a\\b", "C:\\outside"] {
        for limit in [0, 10] {
            assert!(
                matches!(
                    workspace.search_names(path, "file", limit),
                    Err(WorkspaceError::InvalidPath(_))
                ),
                "{path}"
            );
        }
    }
    assert!(matches!(
        workspace.search_names("file", "file", 10),
        Err(WorkspaceError::NotDirectory)
    ));
}

#[cfg(unix)]
#[test]
fn filename_search_skips_links_without_following_them_but_rejects_explicit_link_roots() {
    use std::os::unix::fs::symlink;

    let root = Fixture::new();
    let outside = Fixture::new();
    root.file("safe/FILE.txt");
    outside.file("secret.txt");
    symlink("safe/FILE.txt", root.0.join("file-link")).unwrap();
    symlink("missing", root.0.join("broken-link")).unwrap();
    symlink(".", root.0.join("loop")).unwrap();
    symlink(&outside.0, root.0.join("escape")).unwrap();
    let workspace = root.workspace();
    assert_eq!(
        workspace.search_names("", "file", 10).unwrap(),
        vec!["safe/FILE.txt"]
    );
    for query in ["secret", "link", "loop", "escape"] {
        assert!(
            workspace.search_names("", query, 10).unwrap().is_empty(),
            "{query}"
        );
    }
    for path in ["escape", "escape/secret.txt", "loop", "file-link"] {
        for limit in [0, 10] {
            assert!(matches!(
                workspace.search_names(path, "file", limit),
                Err(WorkspaceError::SymlinkComponent)
            ));
        }
    }
    assert!(matches!(
        WorkspaceRoot::open(root.0.join("loop")),
        Err(WorkspaceError::SymlinkComponent)
    ));
    assert!(matches!(
        workspace.search_entries_bounded("", "no-match", 1, 3),
        Err(WorkspaceError::SearchLimitExceeded)
    ));
    // Filename policy must not silently change content search's strict policy.
    assert!(matches!(
        workspace.search_content("", "needle", 10),
        Err(WorkspaceError::SymlinkComponent)
    ));
}

#[cfg(windows)]
#[test]
fn filename_search_skips_junctions_and_rejects_explicit_junction_roots() {
    let root = Fixture::new();
    let outside = Fixture::new();
    root.file("safe.txt");
    outside.file("secret.txt");
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(root.0.join("escape"))
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction creation failed: {output:?}"
    );
    let workspace = root.workspace();
    assert_eq!(
        workspace.search_names("", "txt", 10).unwrap(),
        vec!["safe.txt"]
    );
    for path in ["escape", "escape/secret.txt"] {
        for limit in [0, 10] {
            assert!(matches!(
                workspace.search_names(path, "secret", limit),
                Err(WorkspaceError::SymlinkComponent)
            ));
        }
    }
    fs::remove_dir(root.0.join("escape")).unwrap();
}

// Linux permits arbitrary filename bytes; macOS filesystems reject these names.
#[cfg(target_os = "linux")]
#[test]
fn filename_search_skips_unrepresentable_discovered_names() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let root = Fixture::new();
    root.file("README.md");
    fs::write(root.0.join(OsString::from_vec(vec![b'f', 0xff])), "").unwrap();
    let invalid_directory = root.0.join(OsString::from_vec(vec![b'd', 0xff]));
    fs::create_dir(&invalid_directory).unwrap();
    fs::write(invalid_directory.join("README.md"), "").unwrap();

    assert_eq!(
        root.workspace().search_names("", "readme", 10).unwrap(),
        vec!["README.md"]
    );
    // Unrepresentable candidates still consume the traversal budget.
    assert!(matches!(
        root.workspace().search_entries_bounded("", "readme", 10, 2),
        Err(WorkspaceError::SearchLimitExceeded)
    ));
}

#[test]
fn content_search_remains_case_sensitive_and_excludes_ignored_directories() {
    let root = Fixture::new();
    root.file("src/main.rs");
    root.file("node_modules/hidden.rs");
    let workspace = root.workspace();
    let results = workspace.search_content("", "needle", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        (&*results[0].path, results[0].line, results[0].column),
        ("src/main.rs", 1, 1)
    );
    assert!(
        workspace
            .search_content("", "NEEDLE", 10)
            .unwrap()
            .is_empty()
    );
    assert!(workspace.search_names("", "hidden", 10).unwrap().is_empty());
}
