use super::*;
use crate::transport::{Transport, TransportConfig};

/// Operator-run admission of an exact copy of a shipped system `ssh_config`.
/// The copy lives in a disposable private directory: `config` plus any
/// `ssh_config.d/*` files (symlink targets copied as private regular files). The
/// only edit is the absolute `/etc/ssh/` Include prefix, made fixture-relative
/// because system Includes are confined to the declaring fixture root. No
/// executable, scan or network operation runs; the redacted startup diagnostic
/// goes to stderr exactly as at owner startup.
#[test]
#[ignore = "operator-run against a disposable copy of the platform defaults"]
fn stock_system_defaults_admission() -> io::Result<()> {
    let Some(system) = std::env::var_os("BIGBUD_STOCK_SSH_CONFIG_COPY").map(PathBuf::from) else {
        return Err(io::Error::other("BIGBUD_STOCK_SSH_CONFIG_COPY is required"));
    };
    let user = Fixture::new()?;
    user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    let root = fs::canonicalize(&user.0)?;
    let result = Transport::new(TransportConfig {
        ssh: root.join("absent-ssh"),
        keyscan: root.join("absent-keyscan"),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 2201,
        user: "remote".to_owned(),
        identity: root.join("identity"),
        known_hosts: root.join("pins"),
        alias_config: Some((user.0.join("config"), "picker".to_owned())),
        system_config: Some(system.join("config")),
        workspace_root: None,
        dev_interactive_terminal: false,
    })
    .map(drop);
    println!("stock system defaults admission: {result:?}");
    if std::env::var_os("BIGBUD_STOCK_SSH_CONFIG_EXPECT_ADMITTED").is_some() {
        assert_eq!(result, Ok(()));
    }
    Ok(())
}
