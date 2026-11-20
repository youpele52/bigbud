use std::fs;
use std::path::PathBuf;

use super::scope::{HomeChild, OsIndexScopeLevel, resolve_scopes_with};
use super::scope_layout::{ScopeLayout, parse_xdg_user_dirs, scope_candidates};
use super::tests::Fixture;

fn child(name: &str, is_directory: bool) -> HomeChild {
    HomeChild {
        name: name.to_owned(),
        is_directory,
    }
}

fn paths(names: &[&str]) -> Vec<PathBuf> {
    names.iter().map(PathBuf::from).collect()
}

fn profile() -> Vec<HomeChild> {
    vec![
        child("AppData", true),
        child("appdata", true),
        child("Documents", true),
        child("Downloads", true),
        child("OneDrive", true),
        child("OneDrive - Contoso", true),
        child("OneDriveNotes.txt", false),
        child(".vscode", true),
        child("Library", true),
        child("NTUSER.DAT", false),
    ]
}

#[test]
fn windows_skips_appdata_and_adds_onedrive_common_folders() {
    let windows = ScopeLayout::WINDOWS;
    assert_eq!(
        scope_candidates(&windows, OsIndexScopeLevel::Unrestricted, &profile(), &[]),
        paths(&[
            "Documents",
            "Downloads",
            "Library",
            "OneDrive",
            "OneDrive - Contoso"
        ])
    );
    let common = scope_candidates(&windows, OsIndexScopeLevel::CommonFolders, &profile(), &[]);
    let mut expected = paths(&["Documents", "Downloads"]);
    for parent in ["OneDrive", "OneDrive - Contoso"] {
        for name in ["Desktop", "Documents", "Downloads", "Music", "Pictures"] {
            expected.push(PathBuf::from(parent).join(name));
        }
    }
    expected.sort();
    assert_eq!(common, expected);
    // macOS never treats OneDrive folders as holding the common folders.
    assert_eq!(
        scope_candidates(
            &ScopeLayout::MACOS,
            OsIndexScopeLevel::CommonFolders,
            &profile(),
            &[]
        ),
        paths(&["Documents", "Downloads"])
    );
}

#[test]
fn linux_keeps_every_visible_folder_and_uses_xdg_common_folders() {
    let linux = ScopeLayout::LINUX;
    let children = [
        child("Documents", true),
        child("Library", true),
        child("Projects", true),
        child(".config", true),
        child("Bilder", true),
    ];
    assert_eq!(
        scope_candidates(&linux, OsIndexScopeLevel::Unrestricted, &children, &[]),
        paths(&["Bilder", "Documents", "Library", "Projects"])
    );
    let xdg = paths(&["Bilder", "Data/Dokumente"]);
    assert_eq!(
        scope_candidates(&linux, OsIndexScopeLevel::CommonFolders, &children, &xdg),
        paths(&["Bilder", "Data/Dokumente", "Documents"])
    );
    // XDG folders never widen the unrestricted level beyond visible home folders.
    assert_eq!(
        scope_candidates(&linux, OsIndexScopeLevel::Unrestricted, &children, &xdg),
        paths(&["Bilder", "Documents", "Library", "Projects"])
    );
}

#[test]
fn xdg_user_dirs_accepts_only_home_relative_common_folders() {
    let text = r#"
# This file is written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/Schreibtisch"
XDG_DOCUMENTS_DIR="$HOME/Data/Dokumente/"
XDG_DOWNLOAD_DIR="$HOME/"
XDG_MUSIC_DIR="/srv/music"
XDG_PICTURES_DIR="$HOME/../other/Pictures"
XDG_TEMPLATES_DIR="$HOME/Vorlagen"
XDG_VIDEOS_DIR="$HOME/Videos"
#XDG_MUSIC_DIR="$HOME/Commented"
XDG_MUSIC_DIR=$HOME/Unquoted
XDG_MUSIC_DIR="$HOME/a\"b"
XDG_MUSIC_DIR="$HOME/$USER"
XDG_MUSIC_DIR="$HOME/./Musik"
XDG_MUSIC_DIR="$HOME/Musik//Alben"
XDG_MUSIC_DIR="$HOME/Musik"
XDG_DESKTOP_DIR="$HOME/Schreibtisch"
"#;
    assert_eq!(
        parse_xdg_user_dirs(text),
        paths(&["Schreibtisch", "Data/Dokumente", "Musik"])
    );
    assert!(parse_xdg_user_dirs("").is_empty());
    assert!(parse_xdg_user_dirs("not a config\n=\n\"$HOME/x\"").is_empty());
}

#[test]
fn resolving_with_the_linux_layout_reads_user_dirs_inside_home_only() {
    let home = Fixture::new();
    let base = home.path();
    for folder in ["Dokumente", "Documents", ".config", "Projects"] {
        fs::create_dir_all(base.join(folder)).unwrap();
    }
    fs::write(
        base.join(".config/user-dirs.dirs"),
        "XDG_DOCUMENTS_DIR=\"$HOME/Dokumente\"\nXDG_MUSIC_DIR=\"$HOME/Missing\"\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        // A user-dirs entry that is a symlink out of home is dropped.
        std::os::unix::fs::symlink("/", base.join("Escape")).unwrap();
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(base.join(".config/user-dirs.dirs"))
            .unwrap();
        std::io::Write::write_all(&mut file, b"XDG_PICTURES_DIR=\"$HOME/Escape\"\n").unwrap();
    }
    assert_eq!(
        resolve_scopes_with(base, OsIndexScopeLevel::CommonFolders, &ScopeLayout::LINUX).unwrap(),
        vec![base.join("Documents"), base.join("Dokumente")]
    );
    // An oversized file names nothing.
    fs::write(
        base.join(".config/user-dirs.dirs"),
        "#".repeat(64 * 1024 + 1),
    )
    .unwrap();
    assert_eq!(
        resolve_scopes_with(base, OsIndexScopeLevel::CommonFolders, &ScopeLayout::LINUX).unwrap(),
        vec![base.join("Documents")]
    );
}

#[test]
fn resolving_with_the_windows_layout_finds_onedrive_folders() {
    let home = Fixture::new();
    let base = home.path();
    for folder in ["AppData/Local", "OneDrive/Documents", "Pictures"] {
        fs::create_dir_all(base.join(folder)).unwrap();
    }
    assert_eq!(
        resolve_scopes_with(
            base,
            OsIndexScopeLevel::CommonFolders,
            &ScopeLayout::WINDOWS
        )
        .unwrap(),
        vec![
            base.join("OneDrive").join("Documents"),
            base.join("Pictures")
        ]
    );
    assert_eq!(
        resolve_scopes_with(base, OsIndexScopeLevel::Unrestricted, &ScopeLayout::WINDOWS).unwrap(),
        vec![base.join("OneDrive"), base.join("Pictures")]
    );
}
