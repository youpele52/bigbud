//! Exact bounded mechanical receipt, separate from signed publication authority.
use super::json;
use crate::service_lease::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Anchor {
    pub dev: u64,
    pub ino: u64,
    pub uid: u64,
    pub gid: u64,
    pub mode: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Stamp {
    pub anchor: Anchor,
    pub nlink: u64,
    pub size: u64,
    pub mtime: u64,
    pub ctime: u64,
}
#[derive(Clone)]
pub(super) struct Entry {
    pub directory: bool,
    pub stamp: Stamp,
    pub sha256: Option<[u8; 32]>,
}
pub(super) struct Receipt {
    pub generation: String,
    pub authority: String,
    pub installation: String,
    pub nonce: String,
    pub archive: [u8; 32],
    pub state: Anchor,
    pub namespace: Anchor,
    pub root: Anchor,
    pub entries: BTreeMap<[u8; 32], Entry>,
}
pub(in crate::service_lease) fn get<'a>(v: &'a Value, key: &str) -> Result<&'a Value> {
    v.get(key).ok_or(Error::Invalid)
}
pub(in crate::service_lease) fn fields(v: &Value, names: &[&str]) -> Result<()> {
    let v = v.as_object().ok_or(Error::Invalid)?;
    if v.len() != names.len() || v.keys().any(|k| !names.contains(&k.as_str())) {
        return Err(Error::Invalid);
    }
    Ok(())
}
pub(in crate::service_lease) fn text(v: &Value, max: usize) -> Result<&str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .ok_or(Error::Invalid)
}
pub(in crate::service_lease) fn uint(v: &Value) -> Result<u64> {
    v.as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(Error::Invalid)
}
pub(in crate::service_lease) fn decimal(v: &Value) -> Result<u64> {
    let s = text(v, 20)?;
    if (s.starts_with('0') && s.len() > 1) || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid);
    }
    s.parse().map_err(|_| Error::Invalid)
}
pub(in crate::service_lease) fn hash(v: &Value) -> Result<[u8; 32]> {
    let s = text(v, 64)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Invalid);
    }
    let mut out = [0; 32];
    for (index, pair) in s.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).map_err(|_| Error::Invalid)?;
        *out.get_mut(index).ok_or(Error::Invalid)? =
            u8::from_str_radix(pair, 16).map_err(|_| Error::Invalid)?;
    }
    Ok(out)
}
fn anchor(v: &Value) -> Result<Anchor> {
    Ok(Anchor {
        dev: decimal(get(v, "dev")?)?,
        ino: decimal(get(v, "ino")?)?,
        uid: decimal(get(v, "uid")?)?,
        gid: decimal(get(v, "gid")?)?,
        mode: decimal(get(v, "mode")?)?,
    })
}
fn exact_anchor(v: &Value) -> Result<Anchor> {
    fields(v, &["dev", "ino", "uid", "gid", "mode"])?;
    let a = anchor(v)?;
    if a.mode != 0o40700 {
        return Err(Error::Invalid);
    }
    Ok(a)
}
fn stamp(v: &Value) -> Result<Stamp> {
    fields(
        v,
        &[
            "dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs",
        ],
    )?;
    Ok(Stamp {
        anchor: anchor(v)?,
        nlink: decimal(get(v, "nlink")?)?,
        size: decimal(get(v, "size")?)?,
        mtime: decimal(get(v, "mtimeNs")?)?,
        ctime: decimal(get(v, "ctimeNs")?)?,
    })
}
pub(super) fn path_digest(directory: bool, relative: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"bigbud.mobile-native-assets-entry.v1\0");
    hash.update(if directory {
        b"directory".as_slice()
    } else {
        b"file".as_slice()
    });
    hash.update(b"\0");
    hash.update(relative.as_bytes());
    hash.finalize().into()
}
impl Receipt {
    pub(super) fn parse(raw: &[u8]) -> Result<Self> {
        let value = json::parse(raw)?;
        fields(
            &value,
            &[
                "schemaVersion",
                "kind",
                "namespace",
                "generation",
                "owner",
                "controller",
                "controllerHost",
                "publication",
                "anchors",
                "contentBytes",
                "entries",
            ],
        )?;
        if uint(get(&value, "schemaVersion")?)? != 1
            || text(get(&value, "kind")?, 32)? != "mobile-native-assets"
            || text(get(&value, "namespace")?, 64)? != "remote-mobile-runtime-v1"
        {
            return Err(Error::Invalid);
        }
        let generation = text(get(&value, "generation")?, 39)?.to_owned();
        let tail = generation.strip_prefix("assets-").ok_or(Error::Invalid)?;
        if tail.len() != 32
            || !tail
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid);
        }
        let owner = get(&value, "owner")?;
        fields(owner, &["authority", "installationFingerprint"])?;
        let identity = get(owner, "authority")?;
        fields(identity, &["authorityId", "keyFingerprint", "keyEpoch"])?;
        let authority = text(get(identity, "authorityId")?, 32)?.to_owned();
        if authority.len() != 32
            || !authority
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || uint(get(identity, "keyEpoch")?)? == 0
        {
            return Err(Error::Invalid);
        }
        let fingerprint = |v: &Value| -> Result<String> {
            let s = text(v, 71)?;
            let tail = s.strip_prefix("sha256:").ok_or(Error::Invalid)?;
            hash(&Value::String(tail.into()))?;
            Ok(s.into())
        };
        fingerprint(get(identity, "keyFingerprint")?)?;
        let installation = fingerprint(get(owner, "installationFingerprint")?)?;
        let controller = get(&value, "controller")?;
        fields(controller, &["id", "pid", "startedAt"])?;
        text(get(controller, "id")?, 128)?;
        text(get(controller, "startedAt")?, 256)?;
        if uint(get(controller, "pid")?)? <= 1 {
            return Err(Error::Invalid);
        }
        let host = get(&value, "controllerHost")?;
        fields(host, &["hostname", "machineId"])?;
        text(get(host, "hostname")?, 256)?;
        text(get(host, "machineId")?, 256)?;
        let publication = get(&value, "publication")?;
        fields(
            publication,
            &[
                "stageId",
                "releaseId",
                "consentRevision",
                "preparationNonce",
                "archiveSha256",
            ],
        )?;
        text(get(publication, "stageId")?, 128)?;
        let release = text(get(publication, "releaseId")?, 79)?;
        hash(&Value::String(
            release
                .strip_prefix("mobile-release:")
                .ok_or(Error::Invalid)?
                .into(),
        ))?;
        if uint(get(publication, "consentRevision")?)? == 0 {
            return Err(Error::Invalid);
        }
        let nonce = text(get(publication, "preparationNonce")?, 128)?.into();
        let archive = hash(get(publication, "archiveSha256")?)?;
        let anchors = get(&value, "anchors")?;
        fields(anchors, &["state", "namespace", "root"])?;
        let state = exact_anchor(get(anchors, "state")?)?;
        let namespace = exact_anchor(get(anchors, "namespace")?)?;
        let root = exact_anchor(get(anchors, "root")?)?;
        if [&namespace, &root].iter().any(|a| a.uid != state.uid) {
            return Err(Error::Invalid);
        }
        let content_bytes = uint(get(&value, "contentBytes")?)?;
        if content_bytes > 128 * 1024 * 1024 {
            return Err(Error::Invalid);
        }
        let values = get(&value, "entries")?
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 16385)
            .ok_or(Error::Invalid)?;
        let mut entries = BTreeMap::new();
        let mut previous = None;
        let mut total = 0u64;
        for item in values {
            let kind = text(get(item, "kind")?, 16)?;
            let directory = match kind {
                "directory" => true,
                "file" => false,
                _ => return Err(Error::Invalid),
            };
            fields(
                item,
                if directory {
                    &["kind", "pathDigest", "stat"]
                } else {
                    &["kind", "pathDigest", "stat", "sha256"]
                },
            )?;
            let digest = hash(get(item, "pathDigest")?)?;
            if previous.is_some_and(|p| p >= digest) {
                return Err(Error::Invalid);
            }
            previous = Some(digest);
            let stat = stamp(get(item, "stat")?)?;
            if stat.anchor.uid != state.uid
                || stat.anchor.mode != if directory { 0o40700 } else { 0o100600 }
                || (!directory && stat.nlink != 1)
            {
                return Err(Error::Invalid);
            }
            let sha256 = if directory {
                None
            } else {
                total = total.checked_add(stat.size).ok_or(Error::Invalid)?;
                Some(hash(get(item, "sha256")?)?)
            };
            entries.insert(
                digest,
                Entry {
                    directory,
                    stamp: stat,
                    sha256,
                },
            );
        }
        if total != content_bytes
            || entries
                .get(&path_digest(true, ""))
                .is_none_or(|e| e.stamp.anchor != root)
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            generation,
            authority,
            installation,
            nonce,
            archive,
            state,
            namespace,
            root,
            entries,
        })
    }
}
