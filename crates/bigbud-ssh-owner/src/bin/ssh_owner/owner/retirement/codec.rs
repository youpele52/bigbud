//! Bounded record encoding for the retirement journal.

use super::{DENIED, Kind};
use crate::{Token, v1::ErrorCode};
use std::fmt::Write as _;

pub(super) const CHILD_PREFIX: &str = "owner.retirement.";
const SLOT_HEX: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum State {
    Intent,
    Bound,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Record {
    pub(super) epoch: String,
    pub(super) kind: Option<Kind>,
    pub(super) state: State,
    pub(super) pid: u32,
    pub(super) start: u64,
    pub(super) namespace: Option<u64>,
}

pub(super) fn child_name(kind: Kind, slot: &str) -> String {
    format!("{CHILD_PREFIX}{}.{slot}", kind.name())
}

/// Parse exactly `owner.retirement.<kind>.<16 lowercase hex>`. Any other
/// `owner.retirement.*` name is unverified evidence and must fail closed.
pub(super) fn parse_child_name(name: &str) -> Result<Kind, ErrorCode> {
    let rest = name.strip_prefix(CHILD_PREFIX).ok_or(DENIED)?;
    let (kind, slot) = rest.split_once('.').ok_or(DENIED)?;
    let kind = Kind::parse(kind).ok_or(DENIED)?;
    if slot.len() != SLOT_HEX
        || !slot
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(DENIED);
    }
    Ok(kind)
}

pub(super) fn is_temp(name: &str) -> bool {
    name.starts_with(".owner.retirement.") && name.ends_with(".tmp")
}

pub(super) fn hex(token: &Token) -> String {
    let mut value = String::with_capacity(64);
    for byte in token {
        let _ = write!(value, "{byte:02x}");
    }
    value
}

pub(super) fn encode(record: &Record) -> String {
    format!(
        "v1\nepoch={}\nkind={}\nstate={}\npid={}\nstart={}\nnamespace={}\n",
        record.epoch,
        record.kind.map_or("owner", Kind::name),
        if record.state == State::Bound {
            "bound"
        } else {
            "intent"
        },
        record.pid,
        record.start,
        record
            .namespace
            .map_or_else(|| "-".to_owned(), |value| value.to_string()),
    )
}

pub(super) fn parse(text: &str) -> Result<Record, ErrorCode> {
    let mut lines = text.lines();
    if lines.next() != Some("v1") {
        return Err(DENIED);
    }
    let mut epoch = None;
    let mut kind = None;
    let mut state = None;
    let mut pid = None;
    let mut start = None;
    let mut namespace = None;
    for line in lines {
        let (key, value) = line.split_once('=').ok_or(DENIED)?;
        match key {
            "epoch" if epoch.is_none() && valid_hex(value) => epoch = Some(value.to_owned()),
            "kind" if kind.is_none() => {
                kind = Some(if value == "owner" {
                    None
                } else {
                    Some(Kind::parse(value).ok_or(DENIED)?)
                })
            }
            "state" if state.is_none() => {
                state = Some(match value {
                    "intent" => State::Intent,
                    "bound" => State::Bound,
                    _ => return Err(DENIED),
                })
            }
            "pid" if pid.is_none() => pid = Some(value.parse().map_err(|_| DENIED)?),
            "start" if start.is_none() => start = Some(value.parse().map_err(|_| DENIED)?),
            "namespace" if namespace.is_none() => {
                namespace = Some(if value == "-" {
                    None
                } else {
                    Some(value.parse().map_err(|_| DENIED)?)
                })
            }
            _ => return Err(DENIED),
        }
    }
    let record = Record {
        epoch: epoch.ok_or(DENIED)?,
        kind: kind.ok_or(DENIED)?,
        state: state.ok_or(DENIED)?,
        pid: pid.ok_or(DENIED)?,
        start: start.ok_or(DENIED)?,
        namespace: namespace.ok_or(DENIED)?,
    };
    if record.state == State::Bound && (record.pid == 0 || record.start == 0) {
        return Err(DENIED);
    }
    if record.state == State::Intent && (record.pid != 0 || record.start != 0) {
        return Err(DENIED);
    }
    Ok(record)
}

pub(super) fn valid_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn slot() -> Result<String, ErrorCode> {
    let token = crate::random_token().map_err(|_| DENIED)?;
    Ok(hex(&token).chars().take(SLOT_HEX).collect())
}
