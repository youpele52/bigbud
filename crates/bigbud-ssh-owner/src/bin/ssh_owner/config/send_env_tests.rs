use super::*;
use crate::transport::{Transport, TransportConfig};
use std::ffi::OsString;
use std::process::Command;

fn fixture_env(entries: &[(&str, &str)]) -> impl Iterator<Item = (OsString, OsString)> {
    entries
        .iter()
        .map(|&(name, value)| (name.into(), value.into()))
}

fn selected() -> io::Result<(Fixture, Fixture, ResolvedConfig)> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!(
        "{ROUTE} SendEnv LANG LC_TIME LANG\n Host unrelated\n SendEnv SSH_AUTH_SOCK\n{}",
        user.keys()
    ))?;
    system.file("config", b"Host *\n SendEnv=LC_*\n")?;
    let resolved = resolve_with_system(
        &user.0.join("config"),
        &system.0.join("config"),
        "picker",
        "local",
    )
    .map_err(|error| io::Error::other(format!("{error:?}")))?;
    Ok((user, system, resolved))
}

const FAKE_SSH: &[u8] = br#"#!/bin/sh
set -eu
options=
probe=no
for arg do
  case "$arg" in
    -n) probe=yes ;;
    SendEnv=*) options="$options|$arg" ;;
    --) break ;;
  esac
done
[ -z "${SSH_AUTH_SOCK+x}${SSH_ASKPASS+x}${ARBITRARY+x}${LANGUAGE+x}${lc_time+x}" ]
if [ "$probe" = yes ]; then
  [ -z "$options" ] && [ "$LC_ALL" = C ] && [ -z "${LANG+x}${LC_TIME+x}${LC_CTYPE+x}" ]
else
  [ "$options" = '|SendEnv=LANG|SendEnv=LC_ALL|SendEnv=LC_CTYPE|SendEnv=LC_TIME' ]
  [ "$LANG/$LC_ALL/$LC_CTYPE/$LC_TIME" = en_US.UTF-8/POSIX/C/fr_FR.UTF-8 ]
  printf '%s\0' BIGBUD_REMOTE_FOLDERS_V1 /home/fixture /fixture
  printf 'd\t%s\0' forwarded
fi
"#;

#[test]
fn send_env_reaches_the_picker_child_but_not_the_health_probe() -> io::Result<()> {
    let (user, system, config) = selected()?;
    let known_hosts = config
        .known_hosts
        .ok_or_else(|| io::Error::other("missing fixture pin store"))?;
    fs::write(
        &known_hosts,
        "[127.0.0.1]:2201 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    )?;
    user.file("fake-ssh", FAKE_SSH)?;
    let root = fs::canonicalize(&user.0)?;
    let ssh = root.join("fake-ssh");
    fs::set_permissions(&ssh, Permissions::from_mode(0o700))?;
    let transport = Transport::new(TransportConfig {
        ssh,
        keyscan: root.join("unused-keyscan"),
        host: config.host,
        port: config.port,
        user: config.user,
        identity: config.identity,
        known_hosts,
        alias_config: Some((user.0.join("config"), "picker".to_owned())),
        system_config: Some(system.0.join("config")),
        workspace_root: None,
        dev_interactive_terminal: false,
    })
    .map_err(|error| io::Error::other(format!("{error:?}")))?;
    let folders = transport
        .list_folders_with_locale(None, || {
            fixture_env(&[
                ("LANG", "en_US.UTF-8"),
                ("LC_ALL", "POSIX"),
                ("LC_TIME", "fr_FR.UTF-8"),
                ("LC_CTYPE", "C"),
                ("lc_time", "exclude-case"),
                ("LANGUAGE", "exclude-broader"),
                ("SSH_AUTH_SOCK", "exclude-agent"),
                ("SSH_ASKPASS", "exclude-askpass"),
                ("ARBITRARY", "exclude-other"),
            ])
        })
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(folders.entries.len(), 1);
    assert_eq!(folders.entries[0].name, "forwarded");
    assert_eq!(
        transport.sample_health().map(|health| health.reachable),
        Ok(true)
    );
    Ok(())
}

#[test]
fn send_env_never_selects_the_default_locale_or_reads_the_environment_for_clean_commands()
-> io::Result<()> {
    let (_user, _system, config) = selected()?;
    let mut command = Command::new("/unused");
    assert_eq!(
        config
            .send_env
            .apply_to(&mut command, || fixture_env(&[("UNRELATED", "value")])),
        Ok(())
    );
    assert_eq!(command.get_args().len(), 0);
    assert_eq!(
        command.get_envs().collect::<Vec<_>>(),
        vec![("LC_ALL".as_ref(), Some("C".as_ref()))]
    );

    let mut clean = Command::new("/unused");
    assert_eq!(
        SendEnv::default().apply_to(&mut clean, || -> std::iter::Empty<_> {
            panic!("a clean command must not read the environment")
        }),
        Ok(())
    );
    assert_eq!(clean.get_args().len(), 0);
    Ok(())
}

#[test]
fn send_env_rejects_unsupported_active_operands_and_excess_patterns() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let overflow = (0..33)
        .map(|index| format!(" LC_TEST{index}"))
        .collect::<String>();
    for operands in [
        "",
        "LANG PATH",
        "LC_* SSH_AUTH_SOCK",
        "LANGUAGE",
        "lang",
        "*",
        "LC_",
        "LC_?",
        "-PATH",
        "-SSH_AUTH_SOCK",
        "-LC_?",
        "LANG,LC_*",
        "\"LANG LC_*\"",
        &overflow,
    ] {
        fixture.write_config(&format!("{ROUTE} SendEnv {operands}\n{}", fixture.keys()))?;
        assert!(
            matches!(fixture.resolve(), Err(UNSUPPORTED)),
            "{operands:?}"
        );
    }
    Ok(())
}

#[test]
fn locale_removals_match_configured_patterns_in_source_order() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!(
        "{ROUTE} SendEnv LANG LC_* LC_TIME -LC_TIME\n{}",
        user.keys()
    ))?;
    let resolve = || {
        resolve_with_system(
            &user.0.join("config"),
            &system.0.join("config"),
            "picker",
            "local",
        )
        .map_err(|error| io::Error::other(format!("{error:?}")))
    };
    let selected = |settings: &ResolvedConfig| {
        let mut command = Command::new("/unused");
        settings
            .send_env
            .apply_to(&mut command, || {
                fixture_env(&[
                    ("LANG", "en_US.UTF-8"),
                    ("LC_TIME", "C"),
                    ("LC_CTYPE", "C"),
                    ("SSH_AUTH_SOCK", "/must-not-send"),
                ])
            })
            .expect("safe synthetic locale values");
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    system.file("config", b"Host *\n SendEnv -LANG\n")?;
    assert_eq!(
        selected(&resolve()?),
        ["-o", "SendEnv=LC_CTYPE", "-o", "SendEnv=LC_TIME"]
    );
    fs::write(
        system.0.join("config"),
        b"Host *\n SendEnv -LANG -LC_* LC_CTYPE\n",
    )?;
    assert_eq!(selected(&resolve()?), ["-o", "SendEnv=LC_CTYPE"]);
    Ok(())
}

#[test]
fn send_env_rejects_excess_expansion_and_oversized_values_without_partial_application()
-> io::Result<()> {
    let (_user, _system, config) = selected()?;
    let mut command = Command::new("/unused");
    assert_eq!(
        config.send_env.apply_to(&mut command, || {
            (0..33).map(|index| (format!("LC_TEST{index}").into(), "fixture".into()))
        }),
        Err(UNSUPPORTED)
    );
    assert_eq!(
        config.send_env.apply_to(&mut command, || {
            std::iter::once(("LANG".into(), "x".repeat(1025).into()))
        }),
        Err(UNSUPPORTED)
    );
    assert_eq!(command.get_args().len(), 0);
    assert_eq!(command.get_envs().len(), 0);
    Ok(())
}
