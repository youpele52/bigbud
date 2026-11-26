//! U17 production scope: OpenSSH's own checks over a real-shaped home
//! (world-readable `~/.ssh` and config, a `~/` Include outside `~/.ssh`,
//! default `~/.ssh/known_hosts`). Synthetic values only.

use super::*;

const KEY_MODE: u32 = 0o600;

fn real_home(fixture: &Fixture) -> io::Result<PathBuf> {
    let home = fixture.0.join("home-u17");
    for (dir, mode) in [
        ("", 0o755),
        (".ssh", 0o755),
        (".tool", 0o700),
        (".tool/ssh", 0o755),
    ] {
        DirBuilder::new().mode(mode).create(home.join(dir))?;
    }
    let write = |name: &str, text: &str, mode: u32| -> io::Result<()> {
        fs::write(home.join(name), text)?;
        fs::set_permissions(home.join(name), Permissions::from_mode(mode))
    };
    write(
        ".tool/ssh/config",
        "Host toolvm\n  Hostname 127.0.0.1\n  User me\n  ProxyCommand '/Applications/Tool.app/h' proxy %h\n",
        0o644,
    )?;
    write(
        ".ssh/config",
        "Include ~/.tool/ssh/config\n\nHost web\n  HostName 10.9.0.1\n  User ops\n  LocalForward 8080 127.0.0.1:80\n\n\
         Host vm\n  HostName 10.9.0.7\n  Port 42977\n  User dev\n  IdentityFile ~/.ssh/id_vm\n  \
         UseKeychain yes\n  AddKeysToAgent yes\n",
        0o644,
    )?;
    write(".ssh/id_vm", "synthetic key material", KEY_MODE)?;
    write(".ssh/known_hosts", "", 0o644)?;
    Ok(home)
}

fn production(home: &Path, alias: &str) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_facts(
        &home.join(".ssh/config"),
        None,
        alias,
        &RouteFacts::default().with_production(),
        true,
    )
    .map_err(|failure| failure.code)
}

#[test]
fn a_real_shaped_home_resolves_with_real_home_paths() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let home = real_home(&fixture)?;
    let resolved = production(&home, "vm").map_err(|e| io::Error::other(format!("{e:?}")))?;
    let canonical = fs::canonicalize(&home)?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(10, 9, 0, 7)));
    assert_eq!((resolved.port, resolved.user.as_str()), (42977, "dev"));
    assert_eq!(resolved.identity, canonical.join(".ssh/id_vm"));
    assert_eq!(
        resolved.known_hosts,
        Some(canonical.join(".ssh/known_hosts"))
    );
    assert!(resolved.revalidate().is_ok());
    // The included tool host keeps its proxy: still refused.
    assert_eq!(production(&home, "toolvm").err(), Some(UNSUPPORTED));
    // The fixture scope still refuses the same world-readable layout.
    assert!(resolve(&home.join(".ssh/config"), "vm", "local").is_err());
    Ok(())
}

#[test]
fn anything_another_account_could_change_or_read_fails_closed() -> io::Result<()> {
    for (path, mode) in [
        (".ssh/id_vm", 0o644),       // a readable private key
        (".ssh/config", 0o664),      // a group-writable config
        (".tool/ssh", 0o775),        // a group-writable Include directory
        (".tool/ssh/config", 0o646), // a world-writable Include
        (".ssh/known_hosts", 0o666), // a writable trust file
        ("", 0o775),                 // a group-writable home
    ] {
        let fixture = Fixture::new()?;
        let home = real_home(&fixture)?;
        fs::set_permissions(home.join(path), Permissions::from_mode(mode))?;
        assert_eq!(production(&home, "vm").err(), Some(UNSUPPORTED), "{path}");
    }
    Ok(())
}

#[test]
fn a_symlinked_include_or_a_missing_default_trust_file_is_refused() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let home = real_home(&fixture)?;
    fs::remove_file(home.join(".ssh/known_hosts"))?;
    assert_eq!(production(&home, "vm").err(), Some(UNSUPPORTED));
    let fixture = Fixture::new()?;
    let home = real_home(&fixture)?;
    fs::rename(home.join(".tool/ssh/config"), home.join(".tool/ssh/real"))?;
    symlink(home.join(".tool/ssh/real"), home.join(".tool/ssh/config"))?;
    assert_eq!(production(&home, "vm").err(), Some(UNSUPPORTED));
    Ok(())
}

#[test]
fn a_host_without_identity_file_uses_openssh_default_keys_that_pass() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let home = real_home(&fixture)?;
    let canonical = fs::canonicalize(&home)?;
    // `web` sets no IdentityFile: nothing usable yet, so it is refused.
    assert_eq!(production(&home, "web").err(), Some(UNSUPPORTED));
    // OpenSSH 10.5 order: id_rsa before id_ed25519. A readable id_rsa is skipped
    // (as OpenSSH skips an unprotected key); the protected id_ed25519 is used.
    for (name, mode) in [
        ("id_rsa", 0o644),
        ("id_ed25519", KEY_MODE),
        ("id_ecdsa_sk", KEY_MODE),
    ] {
        fs::write(home.join(".ssh").join(name), "synthetic key material")?;
        fs::set_permissions(home.join(".ssh").join(name), Permissions::from_mode(mode))?;
    }
    let resolved = production(&home, "web").map_err(|e| io::Error::other(format!("{e:?}")))?;
    assert_eq!(resolved.identity, canonical.join(".ssh/id_ecdsa_sk"));
    assert_eq!(
        resolved.additional_identities,
        vec![canonical.join(".ssh/id_ed25519")]
    );
    assert!(resolved.revalidate().is_ok());
    // The fixture scope never defaults.
    assert!(resolve(&home.join(".ssh/config"), "web", "local").is_err());
    Ok(())
}

/// U17 value-free probe of a real home through the owner's own discovery and
/// admission functions. Run with `BIGBUD_U17_PROBE_HOME=$HOME` and `--ignored`;
/// it prints counts and refusal reasons only, never a name, host or path.
#[test]
#[ignore = "reads a real ~/.ssh/config when BIGBUD_U17_PROBE_HOME is set"]
fn probe_real_home_config() -> io::Result<()> {
    let Ok(home) = std::env::var("BIGBUD_U17_PROBE_HOME") else {
        return Ok(());
    };
    let config = Path::new(&home).join(".ssh/config");
    let system = Path::new("/etc/ssh/ssh_config");
    let system = system.exists().then_some(system);
    let facts = RouteFacts::default().with_production();
    let listed = aliases::list(&config, system, &facts)
        .map_err(|code| io::Error::other(format!("discovery {code:?}")))?;
    let (mut admitted, mut refused) = (0, Vec::new());
    for entry in &listed.entries {
        match resolve_with_facts(&config, system, &entry.alias, &facts, true) {
            Ok(_) => admitted += 1,
            Err(failure) => refused.push(format!(
                "{:?}",
                failure.diagnostic.map(|site| site.directive)
            )),
        }
    }
    let unsupported: Vec<_> = listed
        .entries
        .iter()
        .filter_map(|entry| entry.unsupported.as_ref().map(|item| item.reason.clone()))
        .collect();
    println!(
        "U17 probe: aliases={} discovery_unsupported={unsupported:?} admitted={admitted} \
         refused={refused:?}",
        listed.entries.len()
    );
    Ok(())
}
