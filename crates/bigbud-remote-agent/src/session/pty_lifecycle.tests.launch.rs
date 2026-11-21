//! The local-launch environment validator (plan N1, F3) and the local-launch gate (§12).

use std::time::{Duration, Instant};

use super::super::super::*;
use super::fixture::Host;

fn entry(name: &str, value: &str) -> v1::ProcessEnvironment {
    v1::ProcessEnvironment {
        name: name.to_owned(),
        value: value.to_owned(),
    }
}

#[test]
fn the_local_validator_accepts_300_lowercase_entries_that_the_remote_one_rejects() {
    let entries = (0..300)
        .map(|index| entry(&format!("lower_case_{index}"), "value"))
        .collect::<Vec<_>>();
    let accepted = validate_local_launch_environment(&entries).unwrap();
    assert_eq!(accepted.len(), 300);
    assert!(process_environment_from_entries(&entries).is_err());
}

#[test]
fn the_local_validator_skips_invalid_names_and_huge_values_but_fails_nul_and_caps() {
    let entries = vec![
        entry("BASH_FUNC_x%%", "() {  echo hi\n}"),
        entry("has=equals", "x"),
        entry("9starts_with_digit", "x"),
        entry("", "x"),
        entry("big", &"v".repeat(16 * 1024 + 1)),
        entry("http_proxy", "http://proxy"),
    ];
    let accepted = validate_local_launch_environment(&entries).unwrap();
    assert_eq!(
        accepted,
        vec![("http_proxy".to_owned(), "http://proxy".to_owned())]
    );
    assert!(validate_local_launch_environment(&[entry("A", "nul\0byte")]).is_err());
    let too_many = (0..513)
        .map(|index| entry(&format!("n{index}"), "v"))
        .collect::<Vec<_>>();
    assert!(validate_local_launch_environment(&too_many).is_err());
    let too_big = (0..20)
        .map(|index| entry(&format!("n{index}"), &"v".repeat(16 * 1024 - 8)))
        .collect::<Vec<_>>();
    assert!(validate_local_launch_environment(&too_big).is_err());
}

fn env_request(host: &Host, id: &str) -> v1::PtyCreateRequest {
    let mut request = host.request(id, true, "/usr/bin/env", &[]);
    request.local_launch = true;
    request.environment = vec![
        entry("BASH_FUNC_x%%", "() {  echo hi\n}"),
        entry("http_proxy", "http://proxy.invalid:3128"),
        entry("PATH", "/opt/bigbud-test/bin:/usr/bin:/bin"),
    ];
    request
}

#[test]
fn a_local_launch_skips_bash_functions_and_honours_the_requested_path() {
    let mut host = Host::new(true);
    assert!(host.create(env_request(&host, "env")).accepted);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut text = String::new();
    while Instant::now() < deadline {
        text = host.output_text("env");
        if text.contains("PATH=") && text.contains("http_proxy=") {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        text.contains("http_proxy=http://proxy.invalid:3128"),
        "{text}"
    );
    assert!(
        text.contains("PATH=/opt/bigbud-test/bin:/usr/bin:/bin"),
        "{text}"
    );
    assert!(!text.contains("BASH_FUNC"), "{text}");
}

#[test]
fn local_launch_is_refused_unless_the_host_is_a_local_desktop_host() {
    let host = Host::new(false);
    let refused = host
        .session
        .lock()
        .unwrap()
        .prepare_pty_create(env_request(&host, "env"));
    assert!(matches!(refused, Err(SessionError::Pty(message)) if message.contains("local")));
    // The remote rule still applies to a non-local create with the same environment.
    let mut remote = env_request(&host, "remote");
    remote.local_launch = false;
    assert!(
        host.session
            .lock()
            .unwrap()
            .prepare_pty_create(remote)
            .is_err()
    );
}
