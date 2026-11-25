use super::*;
use std::os::unix::fs::symlink;

fn launch(recipe: &Recipe) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.env_clear()
        .env("NODE_OPTIONS", "--invalid-ambient-option")
        .args(["-c", recipe.command()]);
    cmd
}

fn assert_refuses(recipe: &Recipe) {
    let output = launch(recipe).output().expect("run guest recipe");
    assert_eq!(output.status.code(), Some(126));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn linux_recipe_executes_verified_node_and_preserves_stream_and_module_graph() {
    let Some(node) = node_with_hooks() else {
        return;
    };
    let fixture = Fixture::new();
    let node_bytes = fs::read(node).expect("read host Node executable");
    let node = fixture.file("node's binary", &node_bytes, 0o700);
    let helper = fixture.file("relay's $(not-expanded) #%.mjs", ENTRY.as_bytes(), 0o600);
    let recipe = Recipe::new(
        &node,
        &sha256(&node_bytes),
        &helper,
        &sha256(ENTRY),
        AUTHORITY,
    )
    .expect("relay binding");
    assert_relay_stream(with_payload(&mut launch(&recipe)));
}

#[test]
fn linux_recipe_rejects_wrong_digests_and_unsafe_file_bindings() {
    let fixture = Fixture::new();
    // Regular ELF with predictable status; no dependency on Node for these cases.
    let executable = fs::read("/usr/bin/true").expect("host Linux executable");
    let node = fixture.file("node", &executable, 0o700);
    let helper = fixture.file("relay.mjs", ENTRY.as_bytes(), 0o600);
    let node_sha = sha256(&executable);
    let helper_sha = sha256(ENTRY);
    let bound = |node: &Path, node_sha: &str, helper: &Path, helper_sha: &str| {
        Recipe::new(node, node_sha, helper, helper_sha, AUTHORITY).expect("relay binding")
    };
    let recipe = bound(&node, &node_sha, &helper, &helper_sha);
    assert!(
        launch(&recipe)
            .status()
            .expect("run known executable")
            .success()
    );
    assert_refuses(&bound(&node, &sha256("wrong"), &helper, &helper_sha));
    assert_refuses(&bound(&node, &node_sha, &helper, &sha256("wrong")));

    for (path, unsafe_mode, original_mode) in [(&node, 0o720, 0o700), (&helper, 0o602, 0o600)] {
        fs::set_permissions(path, fs::Permissions::from_mode(unsafe_mode)).expect("unsafe mode");
        assert_refuses(&recipe);
        fs::set_permissions(path, fs::Permissions::from_mode(original_mode)).expect("restore mode");
    }

    let symlink_node = fixture.0.join("node-link");
    symlink(&node, &symlink_node).expect("node link");
    assert_refuses(&bound(&symlink_node, &node_sha, &helper, &helper_sha));

    let symlink_helper = fixture.0.join("relay-link.mjs");
    symlink(&helper, &symlink_helper).expect("helper link");
    assert_refuses(&bound(&node, &node_sha, &symlink_helper, &helper_sha));

    let symlink_parent = fixture.0.join("parent-link");
    symlink(&fixture.0, &symlink_parent).expect("parent link");
    assert_refuses(&bound(
        &node,
        &node_sha,
        &symlink_parent.join("relay.mjs"),
        &helper_sha,
    ));

    let hardlink = fixture.0.join("hardlink.mjs");
    fs::hard_link(&helper, &hardlink).expect("helper hard link");
    assert_refuses(&recipe);
    fs::remove_file(hardlink).expect("remove hard link");

    let fifo = fixture.0.join("fifo.mjs");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .expect("create FIFO")
            .success()
    );
    assert_refuses(&bound(&node, &node_sha, &fifo, &helper_sha));

    let script = b"#!/bin/sh\nprintf 'unexpected launch'\n";
    let script_node = fixture.file("not-node", script, 0o700);
    assert_refuses(&bound(&script_node, &sha256(script), &helper, &helper_sha));

    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o702)).expect("writable parent");
    assert_refuses(&recipe);
}
