//! Owner-death retirement journal.
//!
//! An owner writes its own intent, including its PID, start time and (on
//! Linux) PID-namespace identity, before it may spawn any owned SSH child.
//! Every persistent child gets its own record (`owner.retirement.<kind>.<slot>`)
//! written before `spawn` and completed with the child's identity after it
//! exists, so multi-leg routes never share one slot. Startup verifies every
//! record READ-ONLY: it never signals, adopts, connects to or unlinks an
//! unverified process instance, and never infers exit from a free socket, a
//! lock or PID reuse.
//!
//! Automatic retirement of a still-live exact instance is disabled by default.
//! It requires `BIGBUD_SSH_OWNER_AUTO_RETIRE=approved-disposable` **and** a
//! validated disposable fixture root; otherwise the switch is ignored and a
//! redacted reason is written to stderr. It is not enabled by this change.

use crate::{Token, v1::ErrorCode};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) const UNVERIFIED: ErrorCode = ErrorCode::OwnerRetirementUnverified;
const DENIED: ErrorCode = UNVERIFIED;
const INTENT_FILE: &str = "owner.retirement";
const ENABLE_ENV: &str = "BIGBUD_SSH_OWNER_AUTO_RETIRE";
const ENABLE_VALUE: &str = "approved-disposable";
const MAX_RECORD: usize = 1_024;
const MAX_CHILDREN: usize = 32;
const RETIRE_WAIT: Duration = Duration::from_secs(3);

mod codec;
mod identity;
mod recover;

use codec::{Record, State, child_name, encode, hex, is_temp, parse, parse_child_name, slot};
use identity::{Observed, observe, private_root, read_identity, retire_exact, sync_dir, uid};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Kind {
    Master,
    Connector,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Master => "master",
            Self::Connector => "connector",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "master" => Some(Self::Master),
            "connector" => Some(Self::Connector),
            _ => None,
        }
    }
}

/// One exact child record. `bind` and `clear` address only this instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Instance {
    kind: Kind,
    name: String,
}

impl Instance {
    fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Identity {
    pub(super) pid: u32,
    pub(super) start: u64,
    pub(super) namespace: Option<u64>,
}

/// Read-only verdict for one backend retirement-mirror row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Hydrated {
    /// A pre-spawn intent with no exact identity: unresolved evidence.
    Unresolved,
    /// The exact recorded instance is not running.
    Gone,
    /// The exact recorded instance is still alive.
    Live,
    /// The PID now belongs to a different process (or the namespace differs).
    Reused,
}

/// Applies the journal's own read-only rules to a hydrated row. It never
/// signals, adopts or clears anything: only `Gone` may be admitted.
pub(crate) fn observe_hydrated(
    state: &str,
    pid: u32,
    start: u64,
    namespace: Option<u64>,
) -> Result<Hydrated, ErrorCode> {
    let state = match state {
        "intent" => return Ok(Hydrated::Unresolved),
        "bound" => State::Bound,
        _ => return Err(DENIED),
    };
    let record = Record {
        epoch: String::new(),
        kind: None,
        state,
        pid,
        start,
        namespace,
    };
    Ok(match observe(&record)? {
        Observed::Exact => Hydrated::Live,
        Observed::Gone => Hydrated::Gone,
        Observed::Mismatch => Hydrated::Reused,
    })
}

pub(crate) fn epoch_hex(token: &Token) -> String {
    codec::hex(token)
}

#[derive(Clone, Debug)]
pub(crate) struct Retirement {
    root: PathBuf,
    epoch: Token,
    auto_retire: bool,
}

impl Retirement {
    pub(super) fn for_recovery(root: PathBuf) -> Self {
        Self {
            root,
            epoch: [0; 32],
            auto_retire: false,
        }
    }
    /// Verify any prior record, then write this owner's intent. Refusal happens
    /// before the new intent is written, so a failed start leaves the evidence.
    pub(crate) fn open(
        lock: &Path,
        epoch: Token,
        disposable_fixture: bool,
    ) -> Result<Self, ErrorCode> {
        let requested =
            std::env::var_os(ENABLE_ENV).as_deref() == Some(std::ffi::OsStr::new(ENABLE_VALUE));
        Self::open_with(lock, epoch, requested, disposable_fixture)
    }

    /// The reviewable gate: even an arbitrary "requested" value still needs the
    /// validated disposable fixture before any signalling is possible.
    fn open_with(
        lock: &Path,
        epoch: Token,
        requested: bool,
        disposable_fixture: bool,
    ) -> Result<Self, ErrorCode> {
        let root = private_root(lock)?;
        if requested && !disposable_fixture {
            // Redacted: no path, PID, account or fixture identifier.
            eprintln!(
                "SSH owner retirement automation ignored: this profile is not a validated disposable fixture"
            );
        }
        let retirement = Self {
            root,
            epoch,
            auto_retire: auto_retire_enabled(requested, disposable_fixture),
        };
        retirement.reconcile()?;
        let identity = read_identity(std::process::id()).ok_or(DENIED)?;
        retirement.write(
            INTENT_FILE,
            &Record {
                epoch: hex(&epoch),
                kind: None,
                state: State::Bound,
                pid: identity.pid,
                start: identity.start,
                namespace: identity.namespace,
            },
            false,
        )?;
        Ok(retirement)
    }

    /// Writes a fresh per-instance pre-spawn intent. The slot is generated here,
    /// so two same-kind masters (for example two jump legs) never collide.
    pub(crate) fn begin(&self, kind: Kind) -> Result<Instance, ErrorCode> {
        let instance = Instance {
            kind,
            name: child_name(kind, &slot()?),
        };
        self.write(
            instance.name(),
            &Record {
                epoch: hex(&self.epoch),
                kind: Some(kind),
                state: State::Intent,
                pid: 0,
                start: 0,
                namespace: None,
            },
            false,
        )?;
        Ok(instance)
    }

    /// Completes the intent with the exact child identity. A child whose
    /// identity cannot be read is not admitted; the caller must reap it and
    /// call `clear` only after confirmed exit.
    pub(crate) fn bind(&self, instance: &Instance, pid: u32) -> Result<(), ErrorCode> {
        let identity = read_identity(pid).ok_or(DENIED)?;
        self.write(
            instance.name(),
            &Record {
                epoch: hex(&self.epoch),
                kind: Some(instance.kind),
                state: State::Bound,
                pid: identity.pid,
                start: identity.start,
                namespace: identity.namespace,
            },
            true,
        )
    }

    /// Removes this instance's record only after the caller verified its reap.
    pub(crate) fn clear(&self, instance: &Instance) -> Result<(), ErrorCode> {
        self.remove(instance.name())
    }

    /// Removes the owner intent on a graceful return. Child records stay until
    /// their own verified reap; an unreaped child still blocks the next owner.
    pub(crate) fn clear_owner(&self) {
        // A failed cleanup leaves the intent for the next startup to verify.
        let _ = self.remove(INTENT_FILE);
    }

    fn reconcile(&self) -> Result<(), ErrorCode> {
        let prior = self.read(INTENT_FILE)?;
        if let Some(record) = &prior {
            if record.kind.is_some() || record.state != State::Bound {
                return Err(DENIED);
            }
            match observe(record)? {
                Observed::Gone => {}
                // The lock should have excluded a live owner; never adopt it.
                Observed::Exact | Observed::Mismatch => return Err(DENIED),
            }
        }
        let mut seen = 0usize;
        for entry in fs::read_dir(&self.root).map_err(|_| DENIED)? {
            let entry = entry.map_err(|_| DENIED)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name == INTENT_FILE {
                continue;
            }
            if is_temp(&name) {
                // An interrupted write before rename cannot have spawned a
                // child: `begin` returns only after the rename completes.
                self.remove(&name)?;
                continue;
            }
            if !name.starts_with("owner.retirement.") {
                continue;
            }
            let kind = parse_child_name(&name)?;
            seen += 1;
            if seen > MAX_CHILDREN {
                return Err(DENIED);
            }
            let record = self.read(&name)?.ok_or(DENIED)?;
            if record.kind != Some(kind) {
                return Err(DENIED);
            }
            match observe(&record)? {
                Observed::Gone => self.remove(&name)?,
                Observed::Exact if self.auto_retire => {
                    retire_exact(&record)?;
                    self.remove(&name)?;
                }
                Observed::Exact | Observed::Mismatch => return Err(DENIED),
            }
        }
        if prior.is_some() {
            self.remove(INTENT_FILE)?;
        }
        Ok(())
    }

    fn read(&self, name: &str) -> Result<Option<Record>, ErrorCode> {
        let path = self.root.join(name);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(DENIED),
        };
        if !meta.is_file() || meta.uid() != uid() || meta.mode() & 0o7777 != 0o600 {
            return Err(DENIED);
        }
        let file = File::open(&path).map_err(|_| DENIED)?;
        let mut bytes = Vec::new();
        file.take(MAX_RECORD as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| DENIED)?;
        if bytes.len() > MAX_RECORD {
            return Err(DENIED);
        }
        parse(std::str::from_utf8(&bytes).map_err(|_| DENIED)?).map(Some)
    }

    fn write(&self, name: &str, record: &Record, replace: bool) -> Result<(), ErrorCode> {
        let path = self.root.join(name);
        if !replace && path.exists() {
            return Err(DENIED);
        }
        // Unique temp per write so concurrent/failed writes cannot collide.
        let tmp = self.root.join(format!(".owner.retirement.{}.tmp", slot()?));
        let bytes = encode(record);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&tmp)
            .map_err(|_| DENIED)?;
        file.write_all(bytes.as_bytes()).map_err(|_| DENIED)?;
        file.sync_all().map_err(|_| DENIED)?;
        fs::rename(&tmp, &path).map_err(|_| DENIED)?;
        sync_dir(&self.root)
    }

    fn remove(&self, name: &str) -> Result<(), ErrorCode> {
        let path = self.root.join(name);
        match fs::remove_file(path) {
            Ok(()) => sync_dir(&self.root),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(DENIED),
        }
    }
}

/// Automatic retirement needs both the reviewed switch and the exact fixture
/// proof used by `fence_residual_leases`; anything else fails closed.
fn auto_retire_enabled(requested: bool, disposable_fixture: bool) -> bool {
    requested && disposable_fixture
}

/// One bounded, redacted line for a retirement refusal. No paths, PIDs,
/// accounts or record names are included.
pub(crate) fn report_refusal(code: ErrorCode) {
    if code != UNVERIFIED {
        return;
    }
    const REFUSAL: &str = r#"{"event":"ssh_owner_retirement_refused","version":1,"code":"owner_retirement_unverified","remedy":"Stop bigbud and re-verify the owner retirement record. Use `bigbud-ssh-owner --retirement-recover --lock <stateDir>/backend.lock --record <name>` only when the recorded process is provably gone or its PID is provably reused."}"#;
    let _ = writeln!(std::io::stderr(), "{REFUSAL}");
}

pub(crate) use recover::maybe_run as maybe_run_recovery;

#[cfg(test)]
pub(crate) fn test_identity(pid: u32) -> Option<(u32, u64, Option<u64>)> {
    identity::read_identity(pid).map(|found| (found.pid, found.start, found.namespace))
}

#[cfg(test)]
#[path = "retirement_recover_tests.rs"]
mod recover_tests;
#[cfg(test)]
#[path = "retirement_tests.support.rs"]
mod test_support;
#[cfg(test)]
#[path = "retirement_tests.rs"]
mod tests;
