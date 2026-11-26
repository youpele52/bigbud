//! Explicit operator remedy for a provably absent or PID-reused record.
//!
//! Read-only re-verification happens first. Only a record whose exact instance
//! is verifiably gone (or whose PID now belongs to a different process) is
//! removed. A live exact instance, an unreadable record, an unknown name and a
//! namespace mismatch all refuse. This path never signals.

use super::{
    DENIED, INTENT_FILE, Retirement, UNVERIFIED,
    codec::parse_child_name,
    identity::{Observed, observe, private_root},
};
use crate::v1::ErrorCode;
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Recovered {
    AlreadyAbsent,
    ClearedAbsent,
    ClearedPidReused,
}

impl Recovered {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyAbsent => "already-absent",
            Self::ClearedAbsent => "cleared-absent",
            Self::ClearedPidReused => "cleared-pid-reused",
        }
    }
}

/// Re-verify exactly `name` and clear only a provably absent/reused record.
pub(crate) fn recover(lock: &Path, name: &str) -> Result<Recovered, ErrorCode> {
    let expected_kind = if name == INTENT_FILE {
        None
    } else {
        Some(parse_child_name(name)?)
    };
    let retirement = Retirement::for_recovery(private_root(lock)?);
    let Some(record) = retirement.read(name)? else {
        return Ok(Recovered::AlreadyAbsent);
    };
    if record.kind != expected_kind {
        return Err(DENIED);
    }
    let recovered = match observe(&record)? {
        Observed::Gone => {
            retirement.remove(name)?;
            Recovered::ClearedAbsent
        }
        // A different start time proves this PID now belongs to another
        // process; clearing the record neither signals nor adopts it.
        Observed::Mismatch => {
            retirement.remove(name)?;
            Recovered::ClearedPidReused
        }
        Observed::Exact => return Err(UNVERIFIED),
    };
    Ok(recovered)
}

/// `--retirement-recover --lock <stateDir>/backend.lock --record <name>`.
pub(crate) fn maybe_run(args: &[std::ffi::OsString]) -> Option<crate::RunResult<()>> {
    if args.first().and_then(|value| value.to_str()) != Some("--retirement-recover") {
        return None;
    }
    Some((|| {
        let mut lock = None;
        let mut record = None;
        let mut rest = args.iter().skip(1);
        while let Some(flag) = rest.next() {
            let value = rest.next().ok_or_else(usage)?;
            match flag.to_str() {
                Some("--lock") => lock = Some(value),
                Some("--record") => record = Some(value),
                _ => return Err(usage().into()),
            }
        }
        let lock = lock.ok_or_else(usage)?;
        let record = record.and_then(|value| value.to_str()).ok_or_else(usage)?;
        let recovered = recover(Path::new(lock), record).map_err(|code| {
            std::io::Error::other(format!("retirement recovery refused: {code:?}"))
        })?;
        println!("retirement recovery: {}", recovered.as_str());
        Ok(())
    })())
}

fn usage() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "Usage: bigbud-ssh-owner --retirement-recover --lock <stateDir>/backend.lock --record <owner.retirement|owner.retirement.<kind>.<slot>>",
    )
}
