use super::*;
use crate::transport::{Transport, TransportConfig};
use std::process::Command;
use std::time::Duration;

fn resolved_options(resolved: &ResolvedConfig) -> Result<Vec<String>, ErrorCode> {
    let mut command = Command::new("/unused");
    resolved
        .timers
        .apply_to(&mut command, Duration::from_secs(10))?;
    Ok(command
        .get_args()
        .filter(|arg| *arg != "-o")
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect())
}

#[test]
fn takes_first_active_scalar_in_include_order_then_fills_from_system() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.file("timers.conf", b"ConnectTimeout 03\nServerAliveInterval 2\n")?;
    user.write_config(&format!(
        "Host unrelated\nConnectTimeout none\nServerAliveCountMax -1\n\
         {ROUTE}Include timers.conf\nConnectTimeout 5\nServerAliveInterval 1\n{}",
        user.keys()
    ))?;
    system.file(
        "config",
        b"Host *\nConnectTimeout 7\nServerAliveInterval 4\nServerAliveCountMax 2\nServerAliveCountMax 1\n",
    )?;
    let resolve = || {
        resolve_with_system(
            &user.0.join("config"),
            &system.0.join("config"),
            "picker",
            "local",
        )
    };
    let resolved = resolve().map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(
        resolved_options(&resolved),
        Ok([
            "ConnectTimeout=3",
            "ServerAliveInterval=2",
            "ServerAliveCountMax=2"
        ]
        .map(str::to_owned)
        .to_vec())
    );
    assert_eq!(resolved.revalidate(), Ok(()));
    system.write_config("ConnectTimeout 0\n")?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    assert!(matches!(resolve(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn rejects_unsafe_active_operands_even_after_a_valid_value() -> io::Result<()> {
    let user = Fixture::new()?;
    for keyword in [
        "ConnectTimeout",
        "ServerAliveInterval",
        "ServerAliveCountMax",
    ] {
        for value in [
            "",
            "0",
            "-1",
            "+1",
            "1s",
            "1.5",
            "0x10",
            "none",
            "2147483648",
            "4294967296",
            "1 2",
            "\"1;anything\"",
            "１",
        ] {
            user.write_config(&format!(
                "{ROUTE}{keyword} 1\n{keyword} {value}\n{}",
                user.keys()
            ))?;
            assert!(
                matches!(user.resolve(), Err(UNSUPPORTED)),
                "{keyword}: {value:?}"
            );
        }
    }
    Ok(())
}

#[test]
fn keeps_defaults_and_bounds_partial_keepalive_settings() -> io::Result<()> {
    let user = Fixture::new()?;
    for (policy, expected) in [
        ("", &["ConnectTimeout=10"][..]),
        (
            "ServerAliveCountMax 2\n",
            &["ConnectTimeout=10", "ServerAliveCountMax=2"],
        ),
        (
            "ServerAliveInterval 1\n",
            &[
                "ConnectTimeout=10",
                "ServerAliveInterval=1",
                "ServerAliveCountMax=3",
            ],
        ),
        (
            "ServerAliveInterval 3\n",
            &[
                "ConnectTimeout=10",
                "ServerAliveInterval=3",
                "ServerAliveCountMax=2",
            ],
        ),
    ] {
        user.write_config(&format!("{ROUTE}{policy}{}", user.keys()))?;
        assert_eq!(
            user.resolve()
                .and_then(|resolved| resolved_options(&resolved)),
            Ok(expected.iter().map(|arg| (*arg).to_owned()).collect())
        );
    }
    Ok(())
}

// No real executable, host, or ambient config is used. Check complete option
// multiplicities so an earlier hard-coded value cannot silently win in SSH.
const FAKE_SSH: &[u8] = br#"#!/bin/sh
set -eu
: > "$0.launched"
options=
trust=
probe=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    -F) shift; [ "$1" = /dev/null ] ;;
    -n) probe=yes ;;
    -o)
      shift
      case "$1" in
        ConnectTimeout=*|ServerAliveInterval=*|ServerAliveCountMax=*) options="$options|$1" ;;
        StrictHostKeyChecking=*|UpdateHostKeys=*|GSSAPIAuthentication=*) trust="$trust|$1" ;;
      esac ;;
    --) break ;;
  esac
  shift
done
[ "$trust" = '|StrictHostKeyChecking=yes|UpdateHostKeys=no|GSSAPIAuthentication=no' ]
if [ "$probe" = yes ]; then
  [ "$options" = '|ConnectTimeout=10' ]
else
  [ "$options" = '|ConnectTimeout=9|ServerAliveInterval=4|ServerAliveCountMax=1' ]
  printf '%s\0' BIGBUD_REMOTE_FOLDERS_V1 /home/fixture /fixture
  printf 'd\t%s\0' bounded
fi
"#;

#[test]
fn only_the_pinned_picker_launch_gets_tighter_timing_options() -> io::Result<()> {
    let user = Fixture::new()?;
    let policy = "ConnectTimeout 2147483647\nServerAliveInterval 2147483647\nServerAliveCountMax 2147483647\n";
    user.write_config(&format!("{ROUTE}{policy}{}", user.keys()))?;
    user.file("fake-ssh", FAKE_SSH)?;
    let root = fs::canonicalize(&user.0)?;
    let ssh = root.join("fake-ssh");
    fs::set_permissions(&ssh, Permissions::from_mode(0o700))?;
    let marker = root.join("fake-ssh.launched");
    let pins = root.join("pins");
    let transport = Transport::new(TransportConfig {
        ssh,
        keyscan: root.join("unused-keyscan"),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 2201,
        user: "remote".to_owned(),
        identity: root.join("identity"),
        known_hosts: pins.clone(),
        alias_config: Some((user.0.join("config"), "picker".to_owned())),
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
    })
    .map_err(|error| io::Error::other(format!("{error:?}")))?;
    let list = || transport.list_folders_with_locale(None, std::iter::empty);
    assert!(matches!(list(), Err(ErrorCode::TrustRequired)));
    assert!(!marker.exists());
    fs::write(
        pins,
        "[127.0.0.1]:2201 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    )?;
    assert_eq!(
        list().map(|folders| folders
            .entries
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>()),
        Ok(vec!["bounded".to_owned()])
    );
    assert_eq!(
        transport.sample_health().map(|health| health.reachable),
        Ok(true)
    );
    fs::remove_file(&marker)?;
    user.write_config(&format!("{ROUTE}{policy}ConnectTimeout 0\n{}", user.keys()))?;
    assert!(matches!(list(), Err(UNSUPPORTED)));
    assert!(!marker.exists());
    Ok(())
}
