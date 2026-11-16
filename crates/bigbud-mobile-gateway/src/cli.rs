//! Command-line parsing. The upstream credential comes from the environment,
//! never argv, because process arguments are visible to other local users.

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::config::{ExternalOrigin, GatewayConfig, Limits, Upstream};

pub const CREDENTIAL_ENV: &str = "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL";

pub const USAGE: &str = "usage: bigbud-mobile-gateway --listen 127.0.0.1:PORT \
(--upstream 127.0.0.1:PORT | --upstream-unix PATH) --external-origin https://HOST \
[--assets-dir DIR] [--max-connections N] [--stdin-lifeline]";

pub struct ParsedArgs {
    pub config: GatewayConfig,
    pub stdin_lifeline: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CliError {
    #[error("missing value for {0}")]
    MissingValue(String),
    #[error("invalid value for {0}")]
    InvalidValue(String),
    #[error("unknown argument {0}")]
    Unknown(String),
    #[error("missing required argument {0}")]
    Missing(&'static str),
}

pub fn parse_args(args: &[String], credential: Option<String>) -> Result<ParsedArgs, CliError> {
    let mut listen: Option<SocketAddr> = None;
    let mut upstream: Option<Upstream> = None;
    let mut external_origin: Option<ExternalOrigin> = None;
    let mut assets_dir: Option<PathBuf> = None;
    let mut limits = Limits::default();
    let mut stdin_lifeline = false;
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let mut value = || {
            iter.next()
                .ok_or_else(|| CliError::MissingValue(flag.clone()))
        };
        let invalid = || CliError::InvalidValue(flag.clone());
        match flag.as_str() {
            "--listen" => listen = Some(value()?.parse().map_err(|_| invalid())?),
            "--upstream" => {
                upstream = Some(Upstream::Tcp(value()?.parse().map_err(|_| invalid())?))
            }
            #[cfg(unix)]
            "--upstream-unix" => upstream = Some(Upstream::Unix(PathBuf::from(value()?))),
            "--external-origin" => {
                external_origin = Some(ExternalOrigin::parse(value()?).map_err(|_| invalid())?)
            }
            "--assets-dir" => assets_dir = Some(PathBuf::from(value()?)),
            "--max-connections" => {
                limits.max_connections = value()?.parse().map_err(|_| invalid())?
            }
            "--stdin-lifeline" => stdin_lifeline = true,
            other => return Err(CliError::Unknown(other.to_owned())),
        }
    }
    Ok(ParsedArgs {
        config: GatewayConfig {
            listen: listen.ok_or(CliError::Missing("--listen"))?,
            upstream: upstream.ok_or(CliError::Missing("--upstream"))?,
            external_origin: external_origin.ok_or(CliError::Missing("--external-origin"))?,
            assets_dir,
            upstream_credential: credential.filter(|value| !value.is_empty()),
            limits,
        },
        stdin_lifeline,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_a_complete_command_line() {
        let parsed = parse_args(
            &args(&[
                "--listen",
                "127.0.0.1:0",
                "--upstream",
                "127.0.0.1:3773",
                "--external-origin",
                "https://desk.ts.net",
                "--max-connections",
                "4",
                "--stdin-lifeline",
            ]),
            Some("c".repeat(32)),
        )
        .unwrap();
        assert!(parsed.stdin_lifeline);
        assert_eq!(parsed.config.limits.max_connections, 4);
        assert_eq!(
            parsed.config.upstream_credential.as_deref().map(str::len),
            Some(32)
        );
    }

    #[test]
    fn reports_missing_unknown_and_invalid_arguments() {
        assert_eq!(
            parse_args(&args(&["--listen"]), None).err(),
            Some(CliError::MissingValue("--listen".into()))
        );
        assert_eq!(
            parse_args(&args(&["--bogus"]), None).err(),
            Some(CliError::Unknown("--bogus".into()))
        );
        assert_eq!(
            parse_args(&args(&["--external-origin", "http://x"]), None).err(),
            Some(CliError::InvalidValue("--external-origin".into()))
        );
        assert_eq!(
            parse_args(&args(&[]), None).err(),
            Some(CliError::Missing("--listen"))
        );
    }
}
