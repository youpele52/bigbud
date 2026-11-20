#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::tests::fixture::{Fixture, mode};

#[test]
fn backend_children_find_the_pinned_private_node_before_system_tools() {
    let fixture = Fixture::new();
    let command = fixture.config.command(ServiceRole::Backend).unwrap();
    let (_, value) = command.get_envs().find(|(key, _)| key == &"PATH").unwrap();
    let entries = std::env::split_paths(value.unwrap()).collect::<Vec<_>>();
    assert_eq!(
        entries.first().unwrap(),
        fixture.config.node_binary.parent().unwrap()
    );
    assert_eq!(entries.get(1).unwrap(), Path::new("/usr/local/bin"));
    assert_eq!(entries.get(2).unwrap(), Path::new("/usr/bin"));
    assert_eq!(entries.get(3).unwrap(), Path::new("/bin"));
    assert_eq!(entries.len(), 4);
}

#[test]
fn nonstandard_node_names_cannot_claim_child_node_resolution() {
    let mut fixture = Fixture::new();
    let renamed = fixture.root.join("private-node-renamed");
    std::fs::rename(&fixture.config.node_binary, &renamed).unwrap();
    fixture.config.node_binary = renamed;
    assert!(fixture.config.command(ServiceRole::Backend).is_err());
    assert!(fixture.config.validate_role(ServiceRole::Rust).is_ok());
}

#[test]
fn private_path_separator_cannot_inject_other_command_search_directories() {
    let mut fixture = Fixture::new();
    let directory = fixture.root.join("private:node-runtime");
    std::fs::create_dir(&directory).unwrap();
    mode(&directory, 0o700);
    let moved = directory.join("node");
    std::fs::rename(&fixture.config.node_binary, &moved).unwrap();
    fixture.config.node_binary = moved;
    assert!(fixture.config.command(ServiceRole::Backend).is_err());
    assert!(fixture.config.validate_role(ServiceRole::Rust).is_ok());
}
