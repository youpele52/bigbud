use super::*;

#[test]
fn production_scope_takes_the_request_root_and_a_contained_cwd() {
    assert_eq!(scope(None, "/srv/work", "/srv/work"), Ok(("/srv/work", "")));
    assert_eq!(
        scope(None, "/srv/work", "/srv/work/a b/c"),
        Ok(("/srv/work", "a b/c"))
    );
}

#[test]
fn scope_refuses_root_relative_dot_control_and_escaping_paths() {
    for (root, cwd) in [
        ("/", "/"),
        ("srv/work", "srv/work"),
        ("/srv/work/", "/srv/work/"),
        ("/srv/./work", "/srv/./work"),
        ("/srv/../etc", "/srv/../etc"),
        ("/srv/work", "/srv/work/../other"),
        ("/srv/work", "/srv/workshop"),
        ("/srv/work", "/srv"),
        ("/srv/wo\0rk", "/srv/wo\0rk"),
        ("/srv/work", "/srv/work/a\nb"),
    ] {
        assert_eq!(
            scope(None, root, cwd),
            Err(ErrorCode::WorkspacePathDenied),
            "{root:?} {cwd:?}"
        );
    }
    let long = format!("/{}", "a".repeat(MAX_ROOT_BYTES));
    assert_eq!(
        scope(None, &long, &long),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn a_fixture_owner_admits_only_its_startup_root() {
    assert_eq!(
        scope(Some("/srv/work"), "/srv/work", "/srv/work/sub"),
        Ok(("/srv/work", "sub"))
    );
    assert_eq!(
        scope(Some("/srv/work"), "/srv/other", "/srv/other"),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

fn recipe_fixture(label: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("bigbud-shell-lease-{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("sub")).expect("fixture");
    root.canonicalize().expect("physical fixture")
}

fn run_recipe(root: &str, relative: &str, command: &str, secs: u64) -> std::process::Output {
    let millis = u32::try_from(secs * 1000).expect("small deadline");
    // The remote watchdog deadline is this plus the shared grace.
    let (script, _) = super::super::shell_command(root, relative, command, millis);
    std::process::Command::new("/bin/sh")
        .args(["-c", &script])
        .stdin(std::process::Stdio::null())
        .output()
        .expect("local recipe")
}

#[test]
fn lease_recipe_binds_cwd_passes_the_exit_code_and_adds_no_latency() {
    let root = recipe_fixture("exit");
    let root_str = root.to_str().expect("UTF-8");
    let started = Instant::now();
    let output = run_recipe(root_str, "sub", "printf '%s' \"$PWD\"; cat; exit 9", 30);
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(output.status.code(), Some(9));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{root_str}/sub")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn lease_recipe_kills_the_command_group_at_its_remote_deadline() {
    let root = recipe_fixture("deadline");
    let marker = format!(
        "{}.{}",
        40 + std::process::id() % 50,
        std::process::id() % 997
    );
    let started = Instant::now();
    // The descendant runs in the command's process group and dies with it.
    let output = run_recipe(
        root.to_str().expect("UTF-8"),
        "",
        &format!("sleep {marker} & sleep {marker}"),
        1,
    );
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "{:?}",
        started.elapsed()
    );
    assert_ne!(output.status.code(), Some(0));
    std::thread::sleep(Duration::from_millis(300));
    let survivors = std::process::Command::new("/bin/sh")
        .args(["-c", &format!("pgrep -f '[s]leep {marker}' | wc -l")])
        .output()
        .expect("pgrep");
    assert_eq!(String::from_utf8_lossy(&survivors.stdout).trim(), "0");
    let _ = std::fs::remove_dir_all(root);
}
