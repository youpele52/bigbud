use super::{
    BundleIdentity, HardBlocks, IdentityAppPolicy, IdentityPolicy, IdentityPolicyError,
    IdentitySource, VerifiedApp, enclosing_bundle,
};
use crate::owner::{
    admission::policy_canonical::AppSelector,
    mediation::egress::{AppPolicy, AppVerdict},
};
use std::{
    io,
    num::NonZeroU32,
    path::{Path, PathBuf},
};

fn selector(platform: &str, kind: &str, value: &str) -> AppSelector {
    AppSelector {
        platform: platform.into(),
        kind: kind.into(),
        value: value.into(),
    }
}
fn app(pid: u32, executable: &str, identifier: Option<&str>) -> VerifiedApp {
    let executable = PathBuf::from(executable);
    VerifiedApp {
        pid: NonZeroU32::new(pid).unwrap(),
        creation: format!("boot:{pid}"),
        bundle: enclosing_bundle(&executable).map(|path| BundleIdentity {
            path,
            identifier: identifier.map(str::to_owned),
            file: None,
        }),
        executable_file: None,
        executable,
    }
}
const NOTES: &str = "/Applications/Notes.app/Contents/MacOS/Notes";

#[test]
fn bundle_is_derived_structurally_and_helpers_are_their_own_bundle() {
    assert_eq!(
        enclosing_bundle(Path::new(NOTES)),
        Some(PathBuf::from("/Applications/Notes.app"))
    );
    let helper =
        "/Applications/Chat.app/Contents/Frameworks/Chat Helper.app/Contents/MacOS/Chat Helper";
    assert_eq!(
        enclosing_bundle(Path::new(helper)),
        Some(PathBuf::from(
            "/Applications/Chat.app/Contents/Frameworks/Chat Helper.app"
        ))
    );
    for unbundled in [
        "/bin/sleep",
        "/Applications/Notes.app/Contents/Resources/tool",
        "/x.app/MacOS/x",
    ] {
        assert_eq!(enclosing_bundle(Path::new(unbundled)), None, "{unbundled}");
    }
}

#[test]
fn default_grant_minus_disallows_minus_hard_blocks() {
    let policy = IdentityPolicy::compile(
        &[
            selector("macos", "bundle_id", "com.apple.Notes"),
            selector("macos", "path", "/usr/local/bin/tool"),
            selector("windows", "aumid", "Contoso.App"),
        ],
        HardBlocks {
            bundle_identifiers: vec!["ai.bigbud.desktop".into()],
            pids: vec![NonZeroU32::new(77).unwrap()],
        },
    )
    .unwrap();
    // Bundle identifiers are case-insensitive; labels never participate.
    assert_eq!(
        policy.verdict(&app(1, NOTES, Some("COM.APPLE.NOTES"))),
        AppVerdict::Disallowed
    );
    assert_eq!(
        policy.verdict(&app(2, "/usr/local/bin/tool", None)),
        AppVerdict::Disallowed
    );
    // A bundle path selector also matches the bundle itself.
    let by_bundle = IdentityPolicy::compile(
        &[selector("macos", "path", "/Applications/Notes.app")],
        HardBlocks::default(),
    )
    .unwrap();
    assert_eq!(
        by_bundle.verdict(&app(3, NOTES, None)),
        AppVerdict::Disallowed
    );
    // Hard blocks win over the default grant.
    let host = "/Applications/bigbud.app/Contents/MacOS/bigbud";
    assert_eq!(
        policy.verdict(&app(4, host, Some("ai.bigbud.desktop"))),
        AppVerdict::Disallowed
    );
    assert_eq!(
        policy.verdict(&app(77, "/bin/sleep", None)),
        AppVerdict::Disallowed
    );
    // Everything else is granted, including an unbundled process.
    assert_eq!(
        policy.verdict(&app(5, "/bin/sleep", None)),
        AppVerdict::Permitted
    );
    assert_eq!(
        policy.verdict(&app(
            6,
            "/Applications/Maps.app/Contents/MacOS/Maps",
            Some("com.apple.Maps")
        )),
        AppVerdict::Permitted
    );
}

#[test]
fn unverifiable_selectors_refuse_the_whole_policy() {
    assert_eq!(
        IdentityPolicy::compile(
            &[selector("macos", "code_requirement", "anchor apple")],
            HardBlocks::default()
        ),
        Err(IdentityPolicyError::Unsupported {
            kind: "code_requirement".into()
        })
    );
    for bad in [
        selector("macos", "path", "relative"),
        selector("macos", "bundle_id", "has space"),
    ] {
        assert_eq!(
            IdentityPolicy::compile(&[bad], HardBlocks::default()),
            Err(IdentityPolicyError::Invalid)
        );
    }
}

struct Fake(Option<VerifiedApp>);
impl IdentitySource for Fake {
    fn resolve(&self, _pid: NonZeroU32) -> io::Result<VerifiedApp> {
        self.0
            .clone()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }
}

#[test]
fn egress_policy_excludes_anything_it_cannot_verify() {
    let policy = IdentityPolicy::compile(&[], HardBlocks::default()).unwrap();
    let missing = IdentityAppPolicy {
        source: Fake(None),
        policy: policy.clone(),
    };
    assert_eq!(missing.verdict(5), AppVerdict::Unverified);
    let present = IdentityAppPolicy {
        source: Fake(Some(app(5, "/bin/sleep", None))),
        policy,
    };
    assert_eq!(present.verdict(5), AppVerdict::Permitted);
    // pid 0 (installed, not running) is never resolved or permitted.
    assert_eq!(present.verdict(0), AppVerdict::Unverified);
}

#[test]
fn a_bundle_without_a_valid_identifier_is_never_permitted() {
    // Regression (review P1): a failed CFBundleIdentifier lookup used to
    // fall through to Permitted, bypassing bundle-id restrictions and the
    // hard block on bigbud itself.
    let policy = IdentityPolicy::compile(
        &[selector("macos", "bundle_id", "com.apple.Notes")],
        HardBlocks {
            bundle_identifiers: vec!["ai.bigbud.desktop".into()],
            pids: vec![],
        },
    )
    .unwrap();
    assert_eq!(policy.verdict(&app(1, NOTES, None)), AppVerdict::Unverified);
    let host = "/Applications/bigbud.app/Contents/MacOS/bigbud";
    assert_eq!(policy.verdict(&app(2, host, None)), AppVerdict::Unverified);
    // Executables inside a bundle but not its main executable are not
    // attributable to that bundle's identifier either.
    for inside in [
        "/Applications/Notes.app/Contents/Resources/tool",
        "/Applications/Notes.app/Contents/Library/LoginItems/x",
    ] {
        assert_eq!(
            policy.verdict(&app(3, inside, None)),
            AppVerdict::Unverified
        );
    }
    // A path disallow still wins over "unverified".
    let by_path = IdentityPolicy::compile(
        &[selector("macos", "path", "/Applications/Notes.app")],
        HardBlocks::default(),
    )
    .unwrap();
    assert_eq!(
        by_path.verdict(&app(4, NOTES, None)),
        AppVerdict::Disallowed
    );
}

#[test]
fn path_selectors_must_be_normalized() {
    for bad in [
        "/Applications//Notes.app",
        "/Applications/./Notes.app",
        "/Applications/../Notes.app",
        "/Applications/Notes.app/",
        "/",
        "relative/Notes.app",
    ] {
        assert_eq!(
            IdentityPolicy::compile(&[selector("macos", "path", bad)], HardBlocks::default()),
            Err(IdentityPolicyError::Invalid),
            "{bad}"
        );
    }
}

#[cfg(unix)]
#[test]
fn path_selectors_match_symlinked_names_and_the_same_file_object() {
    let directory = crate::guard::test_support::TestDirectory::new();
    let real = directory.0.join("Real.app");
    std::fs::create_dir(&real).unwrap();
    let link = directory.0.join("Link.app");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let policy = IdentityPolicy::compile(
        &[selector("macos", "path", link.to_str().unwrap())],
        HardBlocks::default(),
    )
    .unwrap();
    // The running bundle is reported under its real (canonical) path.
    let canonical = std::fs::canonicalize(&real).unwrap();
    let executable = canonical.join("Contents/MacOS/Real");
    let mut running = app(5, executable.to_str().unwrap(), Some("com.example.real"));
    assert_eq!(policy.verdict(&running), AppVerdict::Disallowed);
    // Same filesystem object under an unrelated name (firmlink/hard link).
    running.bundle.as_mut().unwrap().path = PathBuf::from("/elsewhere/Other.app");
    running.bundle.as_mut().unwrap().file = super::file_identity(&real);
    assert_eq!(policy.verdict(&running), AppVerdict::Disallowed);
    running.bundle.as_mut().unwrap().file = Some(super::FileIdentity {
        device: 0,
        inode: 0,
    });
    assert_eq!(policy.verdict(&running), AppVerdict::Permitted);
}

#[cfg(unix)]
#[test]
fn safari_cryptex_location_matches_its_applications_path() {
    // Read-only metadata check: /Applications/Safari.app is a symlink into the
    // Cryptex volume, where the running bundle lives.
    let cryptex = Path::new("/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app");
    if !cryptex.exists() || !Path::new("/Applications/Safari.app").exists() {
        return;
    }
    let policy = IdentityPolicy::compile(
        &[selector("macos", "path", "/Applications/Safari.app")],
        HardBlocks::default(),
    )
    .unwrap();
    let mut safari = app(
        6,
        "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
        Some("com.apple.Safari"),
    );
    assert_eq!(policy.verdict(&safari), AppVerdict::Disallowed);
    // Also by file identity alone, whichever name the OS reports.
    safari.bundle.as_mut().unwrap().path = PathBuf::from("/unreported/Safari.app");
    safari.bundle.as_mut().unwrap().file = super::file_identity(cryptex);
    assert_eq!(policy.verdict(&safari), AppVerdict::Disallowed);
}
