use super::*;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const AUTHORITY: &str = "123456789abcdef0123456789abcdef0";
const ENTRY: &str = r#"#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tag } from './graph/chunk.mjs';
if (resolve(process.argv[1]) !== fileURLToPath(import.meta.url) || !import.meta.main ||
    process.argv.length !== 3 || process.env.NODE_OPTIONS ||
    process.env.BIGBUD_RELAY_HELPER_SHA256 || process.env.BIGBUD_RELAY_HELPER_MAX_BYTES) {
    throw new Error('incorrect relay startup');
}
process.stdout.write(`${tag}:${process.argv[2]}:`);
for await (const chunk of process.stdin) process.stdout.write(chunk);
process.stdout.write(':EOF');
"#;
const REPLACEMENT: &str = "process.stdout.write('unverified entry ran');";
const PAYLOAD: &[u8] = b"\x00\x80\xff\nrelay stream\x00";

#[test]
fn binds_all_five_fields_and_quotes_them_as_data() {
    let binding = [
        "/remote/$(exit 99) node's",
        &"12".repeat(32),
        "/remote/$HOME relay's #%.mjs",
        &"ab".repeat(32),
        AUTHORITY,
    ];
    let [node, node_sha, helper, helper_sha, authority] = binding;
    let recipe = Recipe::new(
        Path::new(node),
        node_sha,
        Path::new(helper),
        helper_sha,
        authority,
    )
    .expect("relay binding");
    assert!(recipe.matches_binding(node, node_sha, helper, helper_sha, authority));
    for index in 0..binding.len() {
        let mut other = binding;
        other[index] = if index == 4 {
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        } else {
            binding[(index + 1) % 4]
        };
        let [node, node_sha, helper, helper_sha, authority] = other;
        assert!(!recipe.matches_binding(node, node_sha, helper, helper_sha, authority));
    }
    let command = recipe.command().strip_prefix("exec ").expect("fixed exec");
    let parsed = Command::new("/bin/sh")
        .env_clear()
        .args(["-c", &format!("set -- {command}; printf '%s\\0' \"$@\"")])
        .output()
        .expect("parse command");
    assert!(parsed.status.success());
    let expected = [
        "/usr/bin/env",
        "-i",
        "LC_ALL=C",
        "/bin/bash",
        "-o",
        "pipefail",
        "-c",
        SCRIPT,
        "bigbud-client-relay",
        node,
        node_sha,
        helper,
        helper_sha,
        authority,
        &MAX_BINARY_BYTES.to_string(),
        &MAX_HELPER_BYTES.to_string(),
        &preload_url(),
    ];
    assert_eq!(parsed.stdout, (expected.join("\0") + "\0").into_bytes());
    assert!(
        Command::new("/bin/bash")
            .env_clear()
            .args(["-n", "-c", SCRIPT])
            .status()
            .expect("check syntax")
            .success()
    );
}

#[test]
fn rejects_nonexact_paths_and_ids() {
    let node = Path::new("/remote/bin/node");
    let helper = Path::new("/remote/relay.mjs");
    let hash = "b1".repeat(32);
    for path in [
        Path::new(""),
        Path::new("/"),
        Path::new("agent.mjs"),
        Path::new("//remote/agent.mjs"),
        Path::new("/remote//agent.mjs"),
        Path::new("/remote/./agent.mjs"),
        Path::new("/remote/../agent.mjs"),
        Path::new("/remote/agent.mjs/"),
        Path::new("/remote/agent\n.mjs"),
        Path::new("/remote/agent\0.mjs"),
        Path::new(OsStr::from_bytes(b"/remote/\xff.mjs")),
        Path::new(&format!("/{}.mjs", "x".repeat(MAX_PATH_BYTES))),
    ] {
        assert!(
            Recipe::new(path, &hash, helper, &hash, AUTHORITY).is_err(),
            "{path:?}"
        );
        assert!(
            Recipe::new(node, &hash, path, &hash, AUTHORITY).is_err(),
            "{path:?}"
        );
    }
    assert!(
        Recipe::new(
            node,
            &hash,
            Path::new("/remote/relay.cjs"),
            &hash,
            AUTHORITY
        )
        .is_err()
    );
    for invalid in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
        assert!(Recipe::new(node, &invalid, helper, &hash, AUTHORITY).is_err());
        assert!(Recipe::new(node, &hash, helper, &invalid, AUTHORITY).is_err());
    }
    for invalid in [
        "a".repeat(31),
        "a".repeat(33),
        "A".repeat(32),
        "g".repeat(32),
    ] {
        assert!(Recipe::new(node, &hash, helper, &hash, &invalid).is_err());
    }
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("real temp root")
            .join(format!(
                "bigbud-proof-relay-{:x}",
                Sha256::digest(super::super::random_token().expect("fixture nonce"))
            ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("private fixture directory");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path.join("graph"))
            .expect("private graph directory");
        let fixture = Self(path);
        fixture.file(
            "graph/chunk.mjs",
            b"export const tag = 'relative import';",
            0o600,
        );
        fixture
    }

    fn file(&self, name: &str, contents: &[u8], mode: u32) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, contents).expect("fixture file");
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).expect("fixture mode");
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

fn sha256(contents: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn node_with_hooks() -> Option<PathBuf> {
    let output = Command::new("node")
        .env_remove("NODE_OPTIONS")
        .args([
            "-p",
            "typeof require('node:module').registerHooks === 'function' ? process.execPath : ''",
        ])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8(output.stdout).expect("text Node executable path");
            if !path.trim_end().is_empty() {
                return Some(PathBuf::from(path.trim_end()));
            }
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => panic!("run Node probe: {error}"),
        _ => {}
    }
    eprintln!("Skipping live preload fixture: Node with synchronous hooks is unavailable on PATH");
    None
}

fn with_payload(command: &mut Command) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fixture");
    let written = child
        .stdin
        .take()
        .expect("fixture stdin")
        .write_all(PAYLOAD);
    let output = child.wait_with_output().expect("wait for fixture");
    if output.status.success() {
        written.expect("send fixture payload");
    }
    output
}

fn assert_relay_stream(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let mut expected = format!("relative import:{AUTHORITY}:").into_bytes();
    expected.extend_from_slice(PAYLOAD);
    expected.extend_from_slice(b":EOF");
    assert_eq!(output.stdout, expected);
}

#[test]
fn preload_uses_bound_bytes_at_real_main_url_after_path_replacement() {
    let Some(node) = node_with_hooks() else {
        return;
    };
    let fixture = Fixture::new();
    let opened = fixture.file("original.mjs", ENTRY.as_bytes(), 0o600);
    let path = fixture.file(
        "helper's $(not-expanded) #%.mjs",
        REPLACEMENT.as_bytes(),
        0o600,
    );
    let mut command = Command::new("/bin/bash");
    command.env_clear().args([
        OsStr::new("-c"),
        OsStr::new(r#"exec 8<"$1" 9<"$2"; exec "$2" --preserve-symlinks-main --import "$3" -- "$4" "$5""#),
        OsStr::new("preload-fixture"), opened.as_os_str(), node.as_os_str(),
        OsStr::new(&preload_url()), path.as_os_str(), OsStr::new(AUTHORITY),
    ]).env("BIGBUD_RELAY_HELPER_MAX_BYTES", MAX_HELPER_BYTES.to_string())
      .env("BIGBUD_RELAY_HELPER_SHA256", sha256(ENTRY));
    assert_relay_stream(with_payload(&mut command));

    command.env("BIGBUD_RELAY_HELPER_SHA256", sha256(REPLACEMENT));
    let refused = with_payload(&mut command);
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
}

#[cfg(target_os = "linux")]
#[path = "tests/linux.rs"]
mod linux;
