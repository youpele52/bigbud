use super::{admits, remote_command};

#[test]
fn admits_only_exact_paths_inside_the_root() {
    assert!(admits("/srv/work", "/srv/work"));
    assert!(admits("/srv/work", "/srv/work/repo.git"));
    assert!(!admits("/srv/work", "/srv/workshop/repo.git"));
    assert!(!admits("/srv/work", "/srv/other.git"));
    assert!(!admits("/srv/work", "/srv/work/../other.git"));
    assert!(!admits("/srv/work", "/srv/work/./repo"));
    assert!(!admits("/srv/work", "/srv/work//repo"));
    assert!(!admits("/srv/work", "/srv/work/repo/"));
    assert!(!admits("srv/work", "srv/work/repo"));
    assert!(!admits("/srv/work", "/srv/work/re\npo"));
    assert!(!admits("/", "/etc"));
    assert!(!admits(
        "/srv/work",
        &format!("/srv/work/{}", "a".repeat(1100))
    ));
}

#[test]
fn remote_command_quotes_operands_and_fixes_the_environment() {
    let command = remote_command("/srv/it's", "/srv/it's/r.git");
    assert!(command.starts_with("exec /usr/bin/env -i LC_ALL=C"));
    assert!(command.contains("GIT_CONFIG_GLOBAL=/dev/null"));
    assert!(command.contains("'/srv/it'\\''s/r.git'"));
    assert!(command.contains("git-upload-pack --timeout=60"));
    assert!(!command.contains("receive-pack"));
}
