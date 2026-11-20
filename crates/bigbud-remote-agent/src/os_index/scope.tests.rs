use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::error::OsIndexError;
use super::request::{DEFAULT_OS_INDEX_RESULTS, MAX_OS_INDEX_RESULTS, OsIndexRequest};
use super::scope::{
    HomeChild, OsIndexScopeLevel, resolve_scopes, resolve_scopes_checked, resolve_scopes_with,
    split_by_scope,
};
use super::scope_layout::{ScopeLayout, scope_candidates};
use super::tests::Fixture;
use crate::search::MAX_SEARCH_DEADLINE;

fn child(name: &str, is_directory: bool) -> HomeChild {
    HomeChild {
        name: name.to_owned(),
        is_directory,
    }
}

fn paths(names: &[&str]) -> Vec<PathBuf> {
    names.iter().map(PathBuf::from).collect()
}

#[test]
fn common_folders_keep_only_the_five_existing_folders() {
    let children = [
        child("Desktop", true),
        child("Documents", true),
        child("Music", false),
        child("Pictures", true),
        child("Projects", true),
        child("Library", true),
    ];
    assert_eq!(
        scope_candidates(
            &ScopeLayout::MACOS,
            OsIndexScopeLevel::CommonFolders,
            &children,
            &[]
        ),
        paths(&["Desktop", "Documents", "Pictures"])
    );
}

#[test]
fn unrestricted_uses_visible_home_folders_except_library_plus_cloud_folders() {
    let children = [
        child("Documents", true),
        child("Projects", true),
        child("library", true),
        child("Library", true),
        child(".ssh", true),
        child(".config", true),
        child("notes.txt", false),
        child("Linked", false),
    ];
    assert_eq!(
        scope_candidates(
            &ScopeLayout::MACOS,
            OsIndexScopeLevel::Unrestricted,
            &children,
            &[]
        ),
        paths(&[
            "Documents",
            "Library/CloudStorage",
            "Library/Mobile Documents",
            "Projects"
        ])
    );
}

#[test]
fn split_by_scope_accepts_only_plain_paths_inside_a_scope() {
    let scopes = paths(&["/Users/me/Documents", "/Users/me/Library/CloudStorage"]);
    let inside = Path::new("/Users/me/Documents/taxes/2026.pdf");
    assert_eq!(
        split_by_scope(inside, &scopes),
        Some((
            Path::new("/Users/me/Documents"),
            Path::new("taxes/2026.pdf")
        ))
    );
    assert_eq!(
        split_by_scope(Path::new("/Users/me/Documents"), &scopes),
        Some((Path::new("/Users/me/Documents"), Path::new("")))
    );
    let rejected = [
        "/Users/me/Library/Caches/x",
        "/Users/me/DocumentsOld/x",
        "/Users/me/Documents/../Library/Keychains/x",
        "/Users/me/Documents/./x",
        "/Users/me/Documents//x",
        "/Users/me/Documents/x/",
        "Users/me/Documents/x",
        "/Users/me/Documents/a\0b",
        "/etc/passwd",
    ];
    for path in rejected {
        assert_eq!(split_by_scope(Path::new(path), &scopes), None, "{path:?}");
    }
}

#[test]
fn resolve_scopes_skips_symlinks_files_and_missing_folders() {
    let home = Fixture::new();
    for folder in [
        "Documents",
        "Projects",
        ".ssh",
        "Library/Caches",
        "Library/CloudStorage/Dropbox",
    ] {
        fs::create_dir_all(home.path().join(folder)).unwrap();
    }
    fs::write(home.path().join("Downloads"), b"not a folder").unwrap();
    // Cloud folders are not in the home listing, so they need their own real-folder check.
    fs::write(
        home.path().join("Library/Mobile Documents"),
        b"not a folder",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/", home.path().join("Desktop")).unwrap();
    let base = home.path();
    assert_eq!(
        resolve_scopes_with(base, OsIndexScopeLevel::Unrestricted, &ScopeLayout::MACOS).unwrap(),
        vec![
            base.join("Documents"),
            base.join("Library/CloudStorage"),
            base.join("Projects")
        ]
    );
    assert_eq!(
        resolve_scopes_with(base, OsIndexScopeLevel::CommonFolders, &ScopeLayout::MACOS).unwrap(),
        vec![base.join("Documents")]
    );
    assert_eq!(
        resolve_scopes(&base.join("missing"), OsIndexScopeLevel::Unrestricted),
        Err(OsIndexError::HomeUnavailable)
    );
}

#[test]
fn unreadable_scopes_are_skipped_and_excluded_ones_are_never_touched() {
    let home = Fixture::new();
    let base = home.path();
    for folder in [
        "Documents",
        "Projects",
        "secrets",
        "Library/Mobile Documents",
        "Library/CloudStorage",
    ] {
        fs::create_dir_all(base.join(folder)).unwrap();
    }
    let touched = std::cell::RefCell::new(Vec::new());
    // Stands in for a declined macOS privacy prompt on Documents and iCloud Drive.
    let readable = |path: &Path| {
        touched.borrow_mut().push(path.to_path_buf());
        !(path.ends_with("Documents") || path.ends_with("Mobile Documents"))
    };
    let scopes = resolve_scopes_checked(
        base,
        OsIndexScopeLevel::Unrestricted,
        &ScopeLayout::MACOS,
        &readable,
    )
    .unwrap();
    assert_eq!(
        scopes,
        vec![base.join("Library/CloudStorage"), base.join("Projects")]
    );
    assert!(!touched.borrow().contains(&base.join("secrets")));
    assert!(
        touched
            .borrow()
            .contains(&base.join("Library/Mobile Documents"))
    );

    let none_readable = |_: &Path| false;
    assert_eq!(
        resolve_scopes_checked(
            base,
            OsIndexScopeLevel::CommonFolders,
            &ScopeLayout::MACOS,
            &none_readable
        ),
        Ok(Vec::new())
    );
}

#[test]
fn resolved_scopes_skip_the_per_scope_file_system_checks() {
    let scopes = vec![PathBuf::from("/no/such/scope")];
    let request =
        OsIndexRequest::from_resolved_scopes(" report ", &scopes, 0, Duration::from_secs(1))
            .unwrap();
    assert_eq!(request.query(), "report");
    assert_eq!(request.scopes(), scopes.as_slice());
    assert_eq!(
        OsIndexRequest::from_resolved_scopes("report", &[], 0, Duration::from_secs(1)).err(),
        Some(OsIndexError::NoScopes)
    );
    assert_eq!(
        OsIndexRequest::from_resolved_scopes(" ", &scopes, 0, Duration::from_secs(1)).err(),
        Some(OsIndexError::EmptyQuery)
    );
}

#[test]
fn request_validates_query_and_scopes() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.path().join("docs/.ssh")).unwrap();
    fs::write(fixture.path().join("file.txt"), b"x").unwrap();
    let scope = fixture.path().join("docs");
    let new = |query: &str, scopes: Vec<PathBuf>| {
        OsIndexRequest::new(query, scopes, 0, Duration::from_secs(1)).err()
    };

    assert_eq!(
        new("  ", vec![scope.clone()]),
        Some(OsIndexError::EmptyQuery)
    );
    assert_eq!(
        new("a\nb", vec![scope.clone()]),
        Some(OsIndexError::ControlCharacter)
    );
    assert_eq!(
        new(&"x".repeat(513), vec![scope.clone()]),
        Some(OsIndexError::QueryTooLong)
    );
    assert_eq!(new("ok", vec![]), Some(OsIndexError::NoScopes));
    assert_eq!(
        new("ok", vec![scope.clone(); 65]),
        Some(OsIndexError::TooManyScopes)
    );
    let invalid_scopes = [
        PathBuf::from("docs"),
        fixture.path().join("docs/../docs"),
        fixture.path().join("missing"),
        fixture.path().join("file.txt"),
    ];
    for invalid in invalid_scopes {
        assert_eq!(
            new("ok", vec![invalid.clone()]),
            Some(OsIndexError::InvalidScope),
            "{invalid:?}"
        );
    }
    assert_eq!(
        new("ok", vec![scope.join(".ssh")]),
        Some(OsIndexError::ExcludedScope)
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&scope, fixture.path().join("alias")).unwrap();
        assert_eq!(
            new("ok", vec![fixture.path().join("alias")]),
            Some(OsIndexError::InvalidScope)
        );
    }
    assert_eq!(new(&"x".repeat(512), vec![scope.clone()]), None);
}

#[test]
fn request_trims_deduplicates_and_clamps() {
    let fixture = Fixture::new();
    let scope = fixture.path().to_path_buf();
    let request = OsIndexRequest::new(
        " report ",
        vec![scope.clone(), scope.clone()],
        0,
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(request.query(), "report");
    assert_eq!(request.scopes(), std::slice::from_ref(&scope));
    assert_eq!(request.max_results(), DEFAULT_OS_INDEX_RESULTS);
    assert_eq!(request.deadline(), MAX_SEARCH_DEADLINE);
    let request = OsIndexRequest::new(
        "report",
        vec![scope.clone()],
        10_000,
        Duration::from_millis(5),
    )
    .unwrap();
    assert_eq!(request.max_results(), MAX_OS_INDEX_RESULTS);
    assert_eq!(request.deadline(), Duration::from_millis(5));
    let request = OsIndexRequest::new("report", vec![scope], 7, Duration::ZERO).unwrap();
    assert_eq!(request.max_results(), 7);
}

#[test]
fn home_folder_reads_the_platform_variable() {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let expected = std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    assert_eq!(super::scope::home_folder(), expected);
}
