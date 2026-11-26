//! `meta.json`: the spool's identity, state and coverage facts. Always written atomically.

use std::fs;
use std::io;
use std::path::Path;

use serde_json::{Map, Value};

use super::errors::SpoolError;
use super::layout::write_atomic;

const VERSION: u64 = 1;

/// Retention state of a spool (plan §8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoolState {
    /// A host-owned PTY is (or was, until a crash) writing it.
    Live,
    /// The host died while the PTY was live; kept for cold restore until dismissed or expired.
    Lost,
    /// The PTY closed; the sweep deletes it if the immediate delete failed.
    Closed,
}

impl SpoolState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Lost => "lost",
            Self::Closed => "closed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "live" => Some(Self::Live),
            "lost" => Some(Self::Lost),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SpoolMeta {
    pub(super) pty_id: String,
    pub(super) state: SpoolState,
    pub(super) created_ms: u64,
    pub(super) updated_ms: u64,
    pub(super) lost_at_ms: Option<u64>,
    /// Output stopped being recorded at some point (queue overflow or I/O error).
    pub(super) degraded: bool,
    /// Highest output sequence a rotation or shrink discarded.
    pub(super) discarded_through: Option<u64>,
    /// Sequence covered by the last durable checkpoint.
    pub(super) checkpoint_through: Option<u64>,
}

impl SpoolMeta {
    pub(super) fn new(pty_id: &str, now_ms: u64) -> Self {
        Self {
            pty_id: pty_id.to_owned(),
            state: SpoolState::Live,
            created_ms: now_ms,
            updated_ms: now_ms,
            lost_at_ms: None,
            degraded: false,
            discarded_through: None,
            checkpoint_through: None,
        }
    }

    pub(super) fn encode(&self) -> Vec<u8> {
        let optional = |value: Option<u64>| value.map_or(Value::Null, Value::from);
        let mut object = Map::new();
        object.insert("version".into(), Value::from(VERSION));
        object.insert("ptyId".into(), Value::from(self.pty_id.as_str()));
        object.insert("state".into(), Value::from(self.state.as_str()));
        object.insert("createdMs".into(), Value::from(self.created_ms));
        object.insert("updatedMs".into(), Value::from(self.updated_ms));
        object.insert("lostAtMs".into(), optional(self.lost_at_ms));
        object.insert("degraded".into(), Value::from(self.degraded));
        object.insert("discardedThrough".into(), optional(self.discarded_through));
        object.insert(
            "checkpointThrough".into(),
            optional(self.checkpoint_through),
        );
        Value::Object(object).to_string().into_bytes()
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, SpoolError> {
        let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(bytes) else {
            return Err(SpoolError::Corrupt);
        };
        let number = |key: &str| object.get(key).and_then(Value::as_u64);
        let optional = |key: &str| match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value.as_u64().map(Some).ok_or(SpoolError::Corrupt),
        };
        if number("version") != Some(VERSION) {
            return Err(SpoolError::Corrupt);
        }
        let pty_id = object
            .get("ptyId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(SpoolError::Corrupt)?;
        let state = object
            .get("state")
            .and_then(Value::as_str)
            .and_then(SpoolState::parse)
            .ok_or(SpoolError::Corrupt)?;
        Ok(Self {
            pty_id: pty_id.to_owned(),
            state,
            created_ms: number("createdMs").ok_or(SpoolError::Corrupt)?,
            updated_ms: number("updatedMs").ok_or(SpoolError::Corrupt)?,
            lost_at_ms: optional("lostAtMs")?,
            degraded: object
                .get("degraded")
                .and_then(Value::as_bool)
                .ok_or(SpoolError::Corrupt)?,
            discarded_through: optional("discardedThrough")?,
            checkpoint_through: optional("checkpointThrough")?,
        })
    }

    pub(super) fn load(path: &Path) -> Result<Self, SpoolError> {
        match fs::read(path) {
            Ok(bytes) => Self::decode(&bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(SpoolError::Unknown),
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn store(&self, path: &Path) -> io::Result<()> {
        write_atomic(path, &self.encode())
    }
}
