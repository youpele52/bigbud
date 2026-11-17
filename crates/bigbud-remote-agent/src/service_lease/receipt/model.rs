//! Exact bounded readiness receipt. It is evidence for recovery, never consent or authority.
use crate::local_control::protocol::hex;
use crate::service_lease::assets::model::{decimal, fields, get, hash, text, uint};
use crate::service_lease::{Binding, Controller, Error, Result};
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

pub(in crate::service_lease) const MAX_BYTES: usize = 4096;
const UNIX_PATH_LIMIT: usize = 108;
const KIND: &str = "mobile-gateway-readiness";
const UPSTREAM_ARGUMENT: &str = "--upstream-unix";

/// Original-child loopback listener proven at readiness.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) struct Listener {
    pub address: SocketAddr,
    pub inode: u64,
}
/// Filesystem identity of a sealed private Unix socket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) struct SocketIdentity {
    pub dev: u64,
    pub ino: u64,
}
/// The controller-owned upstream endpoint. `socket: None` means the stale
/// inode was cleared and the current controller has not attached a new one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::service_lease) struct Upstream {
    pub path: PathBuf,
    pub socket: Option<SocketIdentity>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::service_lease) struct Receipt {
    pub revision: u64,
    pub binding: Binding,
    pub original_controller: Controller,
    pub controller: Controller,
    pub child: Controller,
    pub listener: Listener,
    pub upstream: Option<Upstream>,
}

/// The single optional `--upstream-unix PATH` the gateway will dial.
pub(in crate::service_lease) fn upstream_argument(args: &[String]) -> Result<Option<PathBuf>> {
    let mut found = None;
    for (index, argument) in args.iter().enumerate() {
        if argument
            .strip_prefix(UPSTREAM_ARGUMENT)
            .is_some_and(|tail| tail.starts_with('='))
        {
            return Err(Error::Invalid);
        }
        if argument != UPSTREAM_ARGUMENT {
            continue;
        }
        let value = args.get(index + 1).ok_or(Error::Invalid)?;
        if found.is_some() {
            return Err(Error::Invalid);
        }
        found = Some(upstream_path(value)?);
    }
    Ok(found)
}
fn upstream_path(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if !path.is_absolute()
        || value.len() >= UNIX_PATH_LIMIT
        || value.chars().any(char::is_control)
        || path.components().any(|part| {
            !matches!(
                part,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err(Error::Invalid);
    }
    Ok(path.to_path_buf())
}

fn controller(value: &Controller) -> Value {
    json!({ "pid": value.pid, "boot": value.boot, "started": value.started })
}
fn parse_controller(value: &Value) -> Result<Controller> {
    fields(value, &["pid", "boot", "started"])?;
    let pid = u32::try_from(uint(get(value, "pid")?)?).map_err(|_| Error::Invalid)?;
    let started = text(get(value, "started")?, 20)?;
    if pid <= 1 || decimal(get(value, "started")?)? == 0 {
        return Err(Error::Invalid);
    }
    Ok(Controller {
        pid,
        boot: text(get(value, "boot")?, 64)?.to_owned(),
        started: started.to_owned(),
    })
}
fn socket(value: &Value) -> Result<SocketIdentity> {
    fields(value, &["dev", "ino"])?;
    let ino = decimal(get(value, "ino")?)?;
    if ino == 0 {
        return Err(Error::Invalid);
    }
    Ok(SocketIdentity {
        dev: decimal(get(value, "dev")?)?,
        ino,
    })
}

impl Receipt {
    pub(in crate::service_lease) fn encode(&self) -> Result<Vec<u8>> {
        let b = &self.binding;
        let upstream = self.upstream.as_ref().map(|upstream| {
            json!({
                "path": upstream.path.to_string_lossy(),
                "socket": upstream.socket.map(|s| json!({
                    "dev": s.dev.to_string(),
                    "ino": s.ino.to_string(),
                })),
            })
        });
        let bytes = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "kind": KIND,
            "revision": self.revision,
            "binding": {
                "authority": b.authority,
                "installation": b.installation,
                "nativeEpoch": b.native_epoch,
                "nonce": b.nonce,
                "publicationSha256": hex(&b.publication_sha256),
                "executableSha256": hex(&b.executable_sha256),
                "assetsSha256": hex(&b.assets_sha256),
                "configurationSha256": hex(&b.configuration_sha256),
                "guardSha256": hex(&b.guard_sha256),
            },
            "originalController": controller(&self.original_controller),
            "controller": controller(&self.controller),
            "child": controller(&self.child),
            "listener": {
                "address": self.listener.address.to_string(),
                "inode": self.listener.inode.to_string(),
            },
            "upstream": upstream,
        }))
        .map_err(|_| Error::Invalid)?;
        // Re-parse so an unencodable path or identity is never persisted as evidence.
        if bytes.len() > MAX_BYTES || Self::parse(&bytes)? != *self {
            return Err(Error::Invalid);
        }
        Ok(bytes)
    }

    pub(in crate::service_lease) fn parse(raw: &[u8]) -> Result<Self> {
        if raw.len() > MAX_BYTES {
            return Err(Error::Invalid);
        }
        let value = crate::service_lease::assets::json::parse(raw)?;
        fields(
            &value,
            &[
                "schemaVersion",
                "kind",
                "revision",
                "binding",
                "originalController",
                "controller",
                "child",
                "listener",
                "upstream",
            ],
        )?;
        let revision = uint(get(&value, "revision")?)?;
        if uint(get(&value, "schemaVersion")?)? != 1
            || text(get(&value, "kind")?, 32)? != KIND
            || revision == 0
        {
            return Err(Error::Invalid);
        }
        let b = get(&value, "binding")?;
        fields(
            b,
            &[
                "authority",
                "installation",
                "nativeEpoch",
                "nonce",
                "publicationSha256",
                "executableSha256",
                "assetsSha256",
                "configurationSha256",
                "guardSha256",
            ],
        )?;
        let binding = Binding {
            authority: text(get(b, "authority")?, 32)?.to_owned(),
            installation: text(get(b, "installation")?, 71)?.to_owned(),
            native_epoch: text(get(b, "nativeEpoch")?, 128)?.to_owned(),
            nonce: text(get(b, "nonce")?, 128)?.to_owned(),
            publication_sha256: hash(get(b, "publicationSha256")?)?,
            executable_sha256: hash(get(b, "executableSha256")?)?,
            assets_sha256: hash(get(b, "assetsSha256")?)?,
            configuration_sha256: hash(get(b, "configurationSha256")?)?,
            guard_sha256: hash(get(b, "guardSha256")?)?,
        };
        binding.validate()?;
        let l = get(&value, "listener")?;
        fields(l, &["address", "inode"])?;
        let address: SocketAddr = text(get(l, "address")?, 21)?
            .parse()
            .map_err(|_| Error::Invalid)?;
        let inode = decimal(get(l, "inode")?)?;
        if address.ip() != Ipv4Addr::LOCALHOST || address.port() == 0 || inode == 0 {
            return Err(Error::Invalid);
        }
        let upstream = match get(&value, "upstream")? {
            Value::Null => None,
            u => {
                fields(u, &["path", "socket"])?;
                Some(Upstream {
                    path: upstream_path(text(get(u, "path")?, UNIX_PATH_LIMIT)?)?,
                    socket: match get(u, "socket")? {
                        Value::Null => None,
                        s => Some(socket(s)?),
                    },
                })
            }
        };
        Ok(Self {
            revision,
            binding,
            original_controller: parse_controller(get(&value, "originalController")?)?,
            controller: parse_controller(get(&value, "controller")?)?,
            child: parse_controller(get(&value, "child")?)?,
            listener: Listener { address, inode },
            upstream,
        })
    }

    /// The upstream path must be re-attached by the current controller before readiness.
    pub(in crate::service_lease) fn attaching(&self) -> bool {
        self.upstream
            .as_ref()
            .is_some_and(|upstream| upstream.socket.is_none())
    }
}
