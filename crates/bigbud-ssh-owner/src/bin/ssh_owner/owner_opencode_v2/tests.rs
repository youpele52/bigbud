use super::*;
use std::net::Ipv4Addr;

fn recipe() -> ProductRecipe {
    ProductRecipe::new(
        Some(std::path::Path::new("/opt/opencode/opencode-v2")),
        Some(std::path::Path::new("/srv/work/project")),
    )
    .expect("owner-selected v2 recipe")
}

fn scope(cwd: &str) -> ProviderServiceScope {
    ProviderServiceScope {
        thread_id: "thread-v2".into(),
        session_epoch: 3,
        cwd: cwd.into(),
        transport: 1,
    }
}

#[test]
fn admission_binds_the_authorized_root_only() {
    let recipe = recipe();
    assert!(recipe.matches(&scope("/srv/work/project")));
    for rejected in [
        "/srv/work/other",
        "/srv/work/project/..",
        "/srv/work",
        "/",
        "",
    ] {
        assert!(!recipe.matches(&scope(rejected)), "{rejected}");
    }
    for thread in ["", "bad thread", "\n"] {
        assert!(
            !recipe.matches(&ProviderServiceScope {
                thread_id: thread.into(),
                ..scope("/srv/work/project")
            }),
            "{thread:?}"
        );
    }
}

#[test]
fn a_production_recipe_admits_each_requests_own_absolute_cwd() {
    let recipe = ProductRecipe::new(
        Some(std::path::Path::new("/opt/opencode/opencode-v2")),
        None,
    )
    .expect("production v2 recipe");
    for cwd in ["/srv/a/project", "/home/u/work"] {
        assert!(recipe.matches(&scope(cwd)), "{cwd}");
    }
    for rejected in [
        "",
        "/",
        "relative/work",
        "/srv/a/../b",
        "/srv/a/",
        "/srv//a",
        "/srv/a\n",
        "/opt/opencode/opencode-v2",
    ] {
        assert!(!recipe.matches(&scope(rejected)), "{rejected:?}");
    }
    let command = recipe.remote_command(
        "/srv/a/project",
        &"ab".repeat(32),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 50_000),
    );
    assert!(command.contains("'/srv/a/project'"));
}

#[test]
fn recipe_refuses_relative_traversing_or_equal_paths() {
    for (binary, root) in [
        ("opencode", "/srv/work"),
        ("/opt/opencode", "srv/work"),
        ("/opt/../opencode", "/srv/work"),
        ("/opt/opencode/", "/srv/work"),
        ("/opt/opencode", "/opt/opencode"),
        ("/opt/opencode", "/"),
        ("/opt/opencode\n", "/srv/work"),
    ] {
        assert!(
            ProductRecipe::new(
                Some(std::path::Path::new(binary)),
                Some(std::path::Path::new(root))
            )
            .is_err(),
            "{binary} {root}"
        );
    }
}

#[test]
fn remote_command_pins_the_owner_selected_binary_and_loopback_endpoint() {
    let remote = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 51_234);
    let command = recipe().remote_command("/srv/work/project", "ab".repeat(32).as_str(), remote);
    assert!(command.contains("bigbud-opencode-v2"));
    assert!(command.contains("'/opt/opencode/opencode-v2'"));
    assert!(command.contains("'/srv/work/project'"));
    assert!(command.contains(" 127.0.0.1 51234 "));
    assert!(command.contains(" HOME=\"$HOME\" "));
    // The shared executable guard compares the file size with `$limit`; an
    // unset limit made every real binary fail validation with exit 126.
    assert!(LAUNCH.contains("limit=$7"));
    assert!(command.ends_with(&format!(" {LIMIT}")));
    // argv lives only in the owner-shipped supervisor (inlined as one quoted
    // operand), never in the launch template a caller could extend.
    let supervisor = include_str!("supervise.py");
    assert!(supervisor.contains("'serve', '--stdio'"));
    assert!(!LAUNCH.contains("--stdio"));
    assert_eq!(
        command.matches("--stdio").count(),
        supervisor.matches("--stdio").count()
    );
}

#[test]
fn remote_port_selection_stays_inside_the_owner_range() {
    for first in [0_u8, 1, 127, 200, 255] {
        for second in [0_u8, 3, 128, 255] {
            let mut token = [0_u8; 32];
            token[0] = first;
            token[1] = second;
            let port = remote_port(&token);
            assert!(port >= 49_152, "{port}");
            assert!(u32::from(port) < 49_152 + 16_384, "{port}");
        }
    }
}

#[test]
fn a_discovering_recipe_sends_an_empty_operand_and_the_owner_discovery_script() {
    let recipe = ProductRecipe::new(None, None).expect("discovering v2 recipe");
    assert!(recipe.matches(&scope("/srv/a/project")));
    let command = recipe.remote_command(
        "/srv/a/project",
        &"ab".repeat(32),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 50_000),
    );
    // The configured operand is empty; the discovery and its candidates are
    // owner-shipped script text, never a request operand.
    assert!(command.contains(" bigbud-opencode-v2 '' '/srv/a/project' "));
    assert!(command.contains(" SHELL=\"$SHELL\" "));
    for needle in [
        "command -v $1",
        "/usr/bin/timeout -s KILL 5",
        "$HOME/.opencode/bin/opencode",
        "/usr/bin/readlink -e",
        "missing",
    ] {
        assert!(LAUNCH.contains(needle), "{needle}");
    }
    assert!(LAUNCH.contains("select_binary opencode || missing"));
    assert!(LAUNCH.contains("capture_login_env || exit 126"));
}

#[test]
fn a_pre_launch_missing_receipt_is_recorded_only_with_the_exact_nonce() {
    let nonce = "cd".repeat(32);
    let mut control = crate::owner_opencode::Control::new(RECEIPT_TAG, &nonce);
    control.ingest(format!("bigbud-opencode-v2 {} missing\n", "ef".repeat(32)).as_bytes());
    assert!(!control.missing());
    control.ingest(format!("\nbigbud-opencode-v2 {nonce} missing\n").as_bytes());
    assert!(control.missing());
    assert!(!control.prepared());
}
