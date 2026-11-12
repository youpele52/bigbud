use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn exact_inventory_plans_pass_metadata_preflight_without_execution() {
    for platform in ["linux", "macos"] {
        for root in ROOTS {
            for name in NAMES {
                let shell = format!("{root}/{name}");
                let argv = if name == "zsh" {
                    args(&["-o", "nopromptsp"])
                } else {
                    vec![]
                };
                validate_with(&shell, &argv, platform, |path| {
                    assert_eq!(path, Path::new(&shell));
                    fs::metadata("/bin/sh")
                })
                .unwrap();
            }
        }
    }
    // Physical directory spellings match the authenticated inventory's cd -P.
    for root in ROOTS {
        if let Ok(physical) = fs::canonicalize(root) {
            validate_with(physical.join("sh").to_str().unwrap(), &[], "linux", |_| {
                fs::metadata("/bin/sh")
            })
            .unwrap();
        }
    }
}

#[test]
fn unsupported_paths_platforms_and_argv_fail_before_metadata_or_spawn() {
    for (shell, argv, platform) in [
        ("", vec![], "linux"),
        ("sh", vec![], "linux"),
        ("/tmp/sh", vec![], "linux"),
        ("/bin/../bin/sh", vec![], "linux"),
        ("/bin//sh", vec![], "linux"),
        ("/bin/unknown", vec![], "linux"),
        ("/bin/sh\0", vec![], "linux"),
        ("/bin/sh", vec![], "windows"),
        ("/bin/zsh", vec![], "linux"),
        ("/bin/zsh", args(&["-o"]), "linux"),
        ("/bin/zsh", args(&["-o", "nopromptsp", "-l"]), "linux"),
        ("/bin/zsh", args(&["-l", "-o", "nopromptsp"]), "linux"),
        ("/bin/bash", args(&["--norc"]), "linux"),
        ("/bin/fish", args(&["-c", "echo bad"]), "linux"),
        ("/bin/pwsh", args(&["-NoProfile"]), "linux"),
        ("/bin/sh", args(&["-c", "exit 0"]), "linux"),
    ] {
        assert!(
            validate_with(shell, &argv, platform, |_| panic!(
                "no metadata for invalid plan"
            ))
            .is_err()
        );
    }
}

#[test]
fn missing_nonregular_and_nonexecutable_candidates_are_rejected_without_spawning() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "bigbud-profile-preflight-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let executable = root.join("candidate");
    assert!(validate_with("/bin/sh", &[], "linux", |_| fs::metadata(&executable)).is_err());
    assert!(validate_with("/bin/sh", &[], "linux", |_| fs::metadata(&root)).is_err());
    fs::write(&executable, "not run").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(validate_with("/bin/sh", &[], "linux", |_| fs::metadata(&executable)).is_err());
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    validate_with("/bin/sh", &[], "linux", |_| fs::metadata(&executable)).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fixed_native_policy_matches_inventory_source() {
    let candidates =
        include_str!("../../../../apps/server/src/terminal/Layers/ShellProfiles.candidates.ts");
    let strings: Vec<_> = candidates.split('"').skip(1).step_by(2).collect();
    assert_eq!(strings, ROOTS.into_iter().chain(NAMES).collect::<Vec<_>>());
    let protocol = include_str!(
        "../../../../apps/server/src/terminal/Layers/ShellProfiles.remote.protocol.ts"
    );
    assert!(protocol.contains("const args = kind === \"zsh\" ? [\"-o\", \"nopromptsp\"] : [];"));
}
