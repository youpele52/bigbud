use std::path::Path;

use super::error::OsIndexError;
use super::exclusions::{Exclusions, glob_matches};

fn embedded() -> &'static Exclusions {
    Exclusions::embedded().expect("the embedded exclusion list parses")
}

/// `path` is absolute; the scope is `/Users/me/<first component below /Users/me>`.
fn excluded(path: &str) -> bool {
    let path = Path::new(path);
    let below_home = path
        .strip_prefix("/Users/me")
        .expect("test paths live in /Users/me");
    let mut components = below_home.components();
    let scope_name = components.next().expect("test paths sit inside a scope");
    let scope = Path::new("/Users/me").join(scope_name);
    let below = path.strip_prefix(&scope).expect("path is inside its scope");
    embedded().excludes(path, below)
}

#[test]
fn glob_supports_star_anywhere_and_ignores_ascii_case() {
    assert!(glob_matches(b".env*", b".env"));
    assert!(glob_matches(b".env*", b".ENV.local"));
    assert!(glob_matches(b"*.pem", b"server.PEM"));
    assert!(glob_matches(b"*.keychain*", b"login.keychain-db"));
    assert!(glob_matches(b"a*b*c", b"aXXbYYc"));
    assert!(glob_matches(b"*", b""));
    assert!(glob_matches(b"Cookies", b"cookies"));
    assert!(!glob_matches(b"Cookies", b"Cookies.txt"));
    assert!(!glob_matches(b"*.pem", b"pem"));
    assert!(!glob_matches(b"*.pem", b"notes.pem.txt"));
    assert!(!glob_matches(b".env*", b"my.env"));
    assert!(!glob_matches(b"a*b*c", b"aXXbYY"));
    assert!(!glob_matches(b"key3.db", b"key3xdb"));
}

#[test]
fn every_plan_folder_pattern_is_excluded() {
    let folders = [
        "/Users/me/.ssh/config",
        "/Users/me/.gnupg/pubring.kbx",
        "/Users/me/.aws/config",
        "/Users/me/.azure/accessTokens",
        "/Users/me/.kube/config",
        "/Users/me/.docker/config",
        "/Users/me/.config/gcloud/configurations",
        "/Users/me/.password-store/bank.gpg",
        "/Users/me/Library/Keychains/login.db",
        "/Users/me/Library/Mail/V10/inbox.mbox",
        "/Users/me/Library/Messages/chat.db",
        "/Users/me/Library/Cookies/store.binarycookies",
        "/Users/me/Library/Safari/History.db",
        "/Users/me/Library/Application Support/Google/Chrome/Default/History",
        "/Users/me/Library/Application Support/Google/Chrome Canary/Default/History",
        "/Users/me/Library/Application Support/Chromium/Default/History",
        "/Users/me/Library/Application Support/BraveSoftware/Brave-Browser/Default/History",
        "/Users/me/Library/Application Support/Microsoft Edge/Default/History",
        "/Users/me/Library/Application Support/Arc/User Data/Default/History",
        "/Users/me/Library/Application Support/Vivaldi/Default/History",
        "/Users/me/Library/Application Support/Firefox/Profiles/x.default/places.sqlite",
        "/Users/me/Library/Thunderbird/Profiles/x.default/places.sqlite",
        "/Users/me/.config/google-chrome/Default/History",
        "/Users/me/.mozilla/firefox/x.default/places.sqlite",
        "/Users/me/AppData/Local/Google/Chrome/User Data/Default/History",
        "/Users/me/AppData/Roaming/Mozilla/Firefox/Profiles/x/places.sqlite",
        "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/data.sqlite",
        "/Users/me/Library/Containers/com.1password.1password/Data/state",
        "/Users/me/Library/Application Support/Bitwarden/data.json",
        "/Users/me/Library/Application Support/KeePassXC/keepassxc.ini",
        "/Users/me/AppData/Roaming/Microsoft/Credentials/blob",
        "/Users/me/AppData/Local/Microsoft/Vault/policy",
        "/Users/me/.bigbud/state.sqlite",
        "/Users/me/Library/Application Support/bigbud/userdata/state.sqlite",
        "/Users/me/Library/Application Support/bigbud-dev/userdata/state.sqlite",
    ];
    for path in folders {
        assert!(excluded(path), "{path} must be excluded");
    }
}

#[test]
fn every_plan_file_name_pattern_is_excluded_case_insensitively() {
    let names = [
        ".env",
        ".env.local",
        "server.pem",
        "tls.key",
        "id_rsa",
        "id_ed25519.pub",
        "cert.p12",
        "cert.pfx",
        "vault.kdbx",
        "login.keychain-db",
        "credentials",
        "credentials.json",
        "secrets.yaml",
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        "Cookies",
        "Login Data",
        "Web Data",
        "logins.json",
        "key3.db",
        "key4.db",
        "SERVER.PEM",
        ".ENV",
    ];
    for name in names {
        let path = format!("/Users/me/Documents/project/{name}");
        assert!(excluded(&path), "{name} must be excluded");
    }
    // A matching folder hides its whole subtree.
    assert!(excluded("/Users/me/Documents/secrets/plan.txt"));
    assert!(excluded("/Users/me/Documents/.env.d/app.conf"));
}

#[test]
fn ordinary_documents_are_not_excluded() {
    let allowed = [
        "/Users/me/Documents/taxes/2026.pdf",
        "/Users/me/Documents/environment.md",
        "/Users/me/Documents/keynote.key.txt",
        "/Users/me/Documents/my.env.example",
        "/Users/me/Documents/ssh-notes.txt",
        "/Users/me/Downloads/Library/Mailbox.txt",
        "/Users/me/Documents/Chrome/notes.txt",
        "/Users/me/Documents/cookies-recipe.md",
        "/Users/me/Documents/idea.txt",
        "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/report.pages",
        "/Users/me/Library/CloudStorage/Dropbox/plan.docx",
    ];
    for path in allowed {
        assert!(!excluded(path), "{path} must not be excluded");
    }
}

#[test]
fn name_patterns_ignore_the_part_above_the_scope() {
    let list = embedded();
    // A user or volume whose name matches a name pattern must not hide every result.
    let path = Path::new("/Users/id_admin/Documents/report.pdf");
    assert!(!list.excludes(path, Path::new("report.pdf")));
    // Folder patterns still look at the whole path, scope included.
    let path = Path::new("/Users/me/.ssh/known_hosts");
    assert!(list.excludes(path, Path::new("known_hosts")));
}

#[test]
fn excluded_scopes_are_refused() {
    let list = embedded();
    assert!(list.excludes_scope(Path::new("/Users/me/.ssh")));
    assert!(list.excludes_scope(Path::new("/Users/me/Library/Mail")));
    assert!(list.excludes_scope(Path::new("/Users/me/secrets")));
    assert!(!list.excludes_scope(Path::new("/Users/me/Documents")));
    assert!(!list.excludes_scope(Path::new("/Users/id_admin/Documents")));
}

#[test]
fn damaged_lists_fail_closed() {
    let invalid = [
        "not json",
        r#"{"pathSegments": [], "fileNames": ["*.pem"]}"#,
        r#"{"pathSegments": [".ssh"], "fileNames": []}"#,
        r#"{"pathSegments": [".ssh"]}"#,
        r#"{"pathSegments": [""], "fileNames": ["*.pem"]}"#,
        r#"{"pathSegments": ["a//b"], "fileNames": ["*.pem"]}"#,
        r#"{"pathSegments": ["../x"], "fileNames": ["*.pem"]}"#,
        r#"{"pathSegments": [".ssh"], "fileNames": ["a/b"]}"#,
        r#"{"pathSegments": [".ssh"], "fileNames": [7]}"#,
    ];
    for json in invalid {
        assert_eq!(
            Exclusions::parse(json),
            Err(OsIndexError::ExclusionsInvalid),
            "{json}"
        );
    }
    let valid = Exclusions::parse(
        r#"{"pathSegments": [".ssh"], "fileNames": ["*.pem"], "clutterFolders": ["dist"]}"#,
    )
    .expect("minimal list parses");
    assert!(valid.excludes(Path::new("/h/.ssh/x"), Path::new("x")));
    assert!(
        Exclusions::parse(
            r#"{"pathSegments": [".ssh"], "fileNames": ["*.pem"], "clutterFolders": ["../x"]}"#
        )
        .is_err()
    );
}

#[test]
fn clutter_folders_match_only_below_the_scope() {
    let list = embedded();
    for below in [
        "app/node_modules/x.js",
        "repo/.git/HEAD",
        "crate/target/debug/x",
        "a/__pycache__/m.pyc",
        "Library/Caches/x",
    ] {
        assert!(list.is_clutter(Path::new(below)), "{below}");
    }
    // A folder named like clutter above the scope (a user or volume) hides nothing.
    assert!(!list.is_clutter(Path::new("taxes/target-2026.pdf")));
    assert!(!list.excludes(
        Path::new("/Users/me/Documents/repo/.git/HEAD"),
        Path::new("repo/.git/HEAD")
    ));
}
