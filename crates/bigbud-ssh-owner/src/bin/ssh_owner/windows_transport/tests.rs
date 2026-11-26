use super::*;
use std::{ffi::OsStr, path::Path};

const LABEL: &str = "[127.0.0.1]:2200";
const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn path(raw: &str) -> FixturePath {
    FixturePath::new(Path::new(raw)).expect("local fixture path")
}

#[test]
fn refusals_precede_any_inbox_or_filesystem_operation() {
    let config = |host: &str, port, user: &str| TransportConfig {
        host: host.parse().expect("numeric fixture address"),
        port,
        user: user.to_owned(),
        identity: PathBuf::from(r"C:\fixture\id"),
        known_hosts: PathBuf::from(r"C:\fixture\known_hosts"),
    };
    for (host, port, user) in [
        ("127.0.0.2", 2200, "account"),
        ("::1", 2200, "account"),
        ("::ffff:127.0.0.1", 2200, "account"),
        ("192.0.2.1", 2200, "account"),
        (HOST, 0, "account"),
        (HOST, 2200, "-option"),
        (HOST, 2200, "account@elsewhere"),
    ] {
        assert!(matches!(
            WindowsTransport::new(config(host, port, user)),
            Err(ErrorCode::ConfigUnsupported)
        ));
    }
    let mut same_file = config(HOST, 2200, "account");
    same_file.known_hosts = PathBuf::from("c:/FIXTURE/ID");
    assert!(matches!(
        WindowsTransport::new(same_file),
        Err(ErrorCode::ConfigUnsupported)
    ));
}

#[test]
fn fixture_paths_reject_ssh_expansion_and_windows_device_syntax() {
    for invalid in [
        r"id",
        r"C:id",
        r"\path\id",
        r"\\machine\share\id",
        r"\\?\C:\id",
        r"C:\a\..\id",
        r"C:\a\.. \id",
        r"C:\id:stream",
        r"C:\NUL.txt",
        r"C:\fixture\AUX .txt",
        r"C:\a\LPT4",
        r"C:\a\~id",
        r"C:\a\${HOME}",
        r"C:\a\id%h",
        r#"C:\a\id""#,
        r"C:\a\id ",
        r"C:\a\\id",
    ] {
        assert!(
            matches!(
                FixturePath::new(Path::new(invalid)),
                Err(ErrorCode::ConfigUnsupported)
            ),
            "admitted {invalid}"
        );
    }
    assert_eq!(
        path(r"C:\Owner Fixture\id_ed25519").as_str(),
        "C:/Owner Fixture/id_ed25519"
    );
}

#[test]
fn exact_trust_rejects_other_records_or_ambiguous_data() {
    let line = format!("{LABEL} ssh-ed25519 {KEY}");
    assert!(trust::parse_key(b"", LABEL).expect("empty file").is_none());
    for record in [format!("{line}\n"), format!("{line}\r\n")] {
        let pin = trust::parse_key(record.as_bytes(), LABEL)
            .expect("load pin")
            .expect("present pin");
        assert_eq!(
            pin.fingerprint(),
            "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"
        );
    }
    for record in [
        format!("{line}\n{line}\n"),
        format!("{line}\n\n"),
        format!("{line} comment\n"),
        format!("# comment\n{line}\n"),
        format!("{line}\0\n"),
        format!("127.0.0.1 ssh-ed25519 {KEY}\n"),
        format!("@revoked {line}\n"),
        format!("{LABEL} ssh-rsa {KEY}\n"),
        line,
    ] {
        assert!(
            matches!(
                trust::parse_key(record.as_bytes(), LABEL),
                Err(ErrorCode::HostKeyChanged)
            ),
            "admitted {record}"
        );
    }
}

#[test]
fn exact_pin_is_non_overwriting_and_locked_while_used() {
    use std::{fs, time::SystemTime};
    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("valid time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bigbud-win-pin-{}-{nonce}", std::process::id()));
    fs::create_dir(&dir).expect("create test fixture");
    let dir = TempDir(dir);
    let pin_path = dir.0.join("known_hosts");
    drop(fs::File::create_new(&pin_path).expect("initialize fixture pin"));
    let pin = FixturePath::new(&pin_path).expect("ordinary local fixture");
    let key = |blob| {
        HostKey::from_record(format!("{LABEL} ssh-ed25519 {blob}").as_bytes(), LABEL)
            .expect("synthetic key")
    };
    let original = key(KEY);
    let different = key(&KEY.replacen("AAAAIAAA", "AAAAIAAB", 1));
    assert!(!(original == different));
    let deadline = Instant::now() + Duration::from_secs(3);
    TrustFile::approve(&pin, LABEL, &original, deadline).expect("approve original");
    assert!(matches!(
        TrustFile::approve(&pin, LABEL, &different, deadline),
        Err(ErrorCode::HostKeyChanged)
    ));

    let guard = TrustFile::read(&pin, LABEL).expect("hold original pin");
    assert!(guard.key().is_some_and(|key| *key == original));
    assert!(fs::write(&pin_path, b"replacement").is_err());
    assert!(fs::rename(&pin_path, dir.0.join("replacement")).is_err());
    assert_eq!(
        fs::read_to_string(&pin_path).expect("second reader"),
        original.record(LABEL)
    );
}

#[test]
fn inbox_command_contains_only_fixed_policy_and_one_remote_operand() {
    let inbox = Inbox::for_test();
    let scanner = inbox.keyscan(2200);
    let scan_args: Vec<_> = scanner.get_args().collect();
    assert_eq!(
        scanner.get_program(),
        Path::new(r"C:\Windows\System32\OpenSSH\ssh-keyscan.exe")
    );
    assert_eq!(
        scan_args,
        ["-4", "-T", "10", "-t", "ed25519", "-p", "2200", HOST]
    );

    let remote = folders::command(Some("-x; $(touch sentinel) 'quote'")).expect("quoted command");
    let ssh = inbox.ssh(
        2200,
        "account",
        &path(r"C:\Owner Fixture\id_ed25519"),
        &path(r"C:\Owner Fixture\known_hosts"),
        &remote,
    );
    assert_eq!(
        ssh.get_program(),
        Path::new(r"C:\Windows\System32\OpenSSH\ssh.exe")
    );
    assert_eq!(
        ssh.get_current_dir(),
        Some(Path::new(r"C:\Windows\System32"))
    );
    assert_eq!(
        ssh.get_envs().collect::<Vec<_>>(),
        [(OsStr::new("SystemRoot"), Some(OsStr::new(r"C:\Windows")))]
    );
    let args = ssh.get_args().collect::<Vec<_>>();
    assert!(args.starts_with(&["-4", "-T", "-n", "-F", "NUL"].map(OsStr::new)));
    assert!(args.ends_with(&["--", HOST, &remote].map(OsStr::new)));
    assert_eq!(args.iter().filter(|arg| **arg == "-i").count(), 1);
    for fixed in [
        r#"UserKnownHostsFile="C:/Owner Fixture/known_hosts""#,
        "GlobalKnownHostsFile=NUL",
        "StrictHostKeyChecking=yes",
        "HostKeyAlgorithms=ssh-ed25519",
        "BatchMode=yes",
        "PreferredAuthentications=publickey",
        "PubkeyAcceptedKeyTypes=ssh-ed25519",
        "IdentityAgent=none",
        "CertificateFile=none",
        "PasswordAuthentication=no",
        "ChallengeResponseAuthentication=no",
        "ProxyCommand=none",
        "ClearAllForwardings=yes",
    ] {
        assert!(args.contains(&OsStr::new(fixed)), "missing {fixed}");
    }
}
