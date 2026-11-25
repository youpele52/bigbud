use super::*;
use std::net::Ipv4Addr;

fn recipe() -> ProductRecipe {
    ProductRecipe::new(
        std::path::Path::new("/opt/opencode/opencode-v2"),
        std::path::Path::new("/srv/work/project"),
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
            ProductRecipe::new(std::path::Path::new(binary), std::path::Path::new(root)).is_err(),
            "{binary} {root}"
        );
    }
}

#[test]
fn remote_command_pins_the_owner_selected_binary_and_loopback_endpoint() {
    let remote = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 51_234);
    let command = recipe().remote_command("ab".repeat(32).as_str(), remote);
    assert!(command.contains("bigbud-opencode-v2"));
    assert!(command.contains("'/opt/opencode/opencode-v2'"));
    assert!(command.contains("'/srv/work/project'"));
    assert!(command.contains(" 127.0.0.1 51234 "));
    assert!(command.contains(" HOME=\"$HOME\" "));
    // argv lives only in the owner-shipped supervisor, never in the command
    // template a caller could extend.
    assert!(!command.contains("--stdio"));
    assert!(include_str!("supervise.py").contains("'serve', '--stdio'"));
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
            assert!(port < 49_152 + 16_384, "{port}");
        }
    }
}
