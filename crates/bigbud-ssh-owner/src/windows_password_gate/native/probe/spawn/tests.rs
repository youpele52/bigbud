use super::*;

#[test]
fn fixed_environment_contains_only_system_root_and_askpass_bootstrap() {
    let env = environment(
        Path::new(r"C:\Windows"),
        OsStr::new(r"C:\private fixture\helper.exe"),
        "endpoint-token-handle",
        None,
    );
    let env = String::from_utf16(&env).expect("our fixture values are valid UTF-16");
    assert_eq!(
        env.split_terminator('\0').collect::<Vec<_>>(),
        [
            "BIGBUD_SSH_PASSWORD_HELPER_V1=endpoint-token-handle",
            "DISPLAY=bigbud:0",
            r"SSH_ASKPASS=C:\private fixture\helper.exe",
            "SSH_ASKPASS_REQUIRE=force",
            r"SystemRoot=C:\Windows",
            "",
        ]
    );
}

#[test]
fn quotes_paths_and_embedded_known_hosts_quotes_for_windows_argv() {
    let args = [
        r"C:\Program Files\OpenSSH\ssh.exe",
        "-o",
        r#"UserKnownHostsFile="C:/private fixture/hosts""#,
    ];
    let encoded = command_line(args.map(OsStr::new)).expect("guarded values contain no NUL");
    let joined = String::from_utf16(&encoded).unwrap();
    assert_eq!(
        joined.strip_suffix('\0'),
        Some(
            r#""C:\Program Files\OpenSSH\ssh.exe" "-o" "UserKnownHostsFile=\"C:/private fixture/hosts\"""#
        )
    );
    assert!(command_line([OsStr::new("embedded\0nul")]).is_err());
}
