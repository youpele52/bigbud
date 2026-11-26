use super::{DEADLINE, ErrorCode, ObservedHostKey, Transport, host_key, trust_store};
use crate::config::HostVerification;
use std::{
    fs,
    io::ErrorKind,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const READ_ONLY: ErrorCode = ErrorCode::TrustStoreReadOnly;

// The bootstrap path is only an anchor for creating transient snapshots in
// global-only mode. It must not designate any configured trust source.
pub(super) fn check_snapshot_anchor(anchor: &Path, globals: &[PathBuf]) -> Result<(), ErrorCode> {
    let parent = trust_store::check_directory(anchor)?;
    let canonical = fs::canonicalize(parent)
        .map_err(|_| READ_ONLY)?
        .join(anchor.file_name().ok_or(READ_ONLY)?);
    if globals.contains(&canonical) {
        return Err(ErrorCode::ConfigUnsupported);
    }
    match fs::symlink_metadata(anchor) {
        // Absent is valid: the bootstrap anchor is never created or opened.
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Ok(anchor) if anchor.is_file() && anchor.nlink() == 1 => {
            for global in globals {
                let source = fs::symlink_metadata(global).map_err(|_| READ_ONLY)?;
                if (source.dev(), source.ino()) == (anchor.dev(), anchor.ino()) {
                    return Err(ErrorCode::ConfigUnsupported);
                }
            }
            Ok(())
        }
        Ok(_) => Err(ErrorCode::ConfigUnsupported),
        Err(_) => Err(READ_ONLY),
    }
}

impl Transport {
    pub(in super::super) fn inspect(&self) -> Result<ObservedHostKey, ErrorCode> {
        self.inspect_with(Instant::now() + DEADLINE, |deadline| {
            self.scan_keys(deadline)
        })
    }

    pub(super) fn inspect_with(
        &self,
        deadline: Instant,
        observe: impl FnOnce(Instant) -> Result<Vec<host_key::HostKey>, ErrorCode>,
    ) -> Result<ObservedHostKey, ErrorCode> {
        self.revalidate_policy()?;
        if self.host_verification() == HostVerification::Ed25519Certificate {
            self.certificate_authority(deadline)?;
            // No credential-bearing probe from inspect, and keyscan cannot
            // attest that the real handshake would accept a host certificate.
            return Err(ErrorCode::ConfigUnsupported);
        }
        let extended = self
            .configured_trust()
            .map(|sources| sources.read(&self.host_label, deadline))
            .transpose()?;
        let offered = observe(deadline)?;
        let (pin, trust_stamp) = match extended {
            Some(inspection) => (inspection.pin, Some(inspection.stamp)),
            None => (self.pin()?, None),
        };
        // U23: with a pin, the most preferred offered key of a pinned type must
        // be pinned; a different key, or only unpinned types, has changed. A
        // conflicting pin is not a new first-use challenge. Without a pin, the
        // most preferred offered key (ed25519 first) is the challenge.
        let (raw, verified) = match pin {
            Some(pin) => match offered.into_iter().find(|key| pin.has_type(key)) {
                Some(key) if pin.contains(&key) => (key, true),
                _ => return Err(ErrorCode::HostKeyChanged),
            },
            None => (
                offered.into_iter().next().ok_or(ErrorCode::TransportLost)?,
                false,
            ),
        };
        Ok(ObservedHostKey {
            verified,
            fingerprint: raw.fingerprint(),
            key_type: raw.key_type().to_owned(),
            raw,
            scope: Arc::clone(&self.config),
            trust_stamp,
        })
    }

    pub(in super::super) fn approve(&self, expected: &ObservedHostKey) -> Result<(), ErrorCode> {
        self.approve_with(expected, Instant::now() + DEADLINE, |deadline| {
            self.scan_keys(deadline)
        })
    }

    pub(super) fn approve_with(
        &self,
        expected: &ObservedHostKey,
        deadline: Instant,
        observe: impl FnOnce(Instant) -> Result<Vec<host_key::HostKey>, ErrorCode>,
    ) -> Result<(), ErrorCode> {
        self.revalidate_policy()?;
        if !Arc::ptr_eq(&self.config, &expected.scope)
            || expected.key_type != expected.raw.key_type()
            || expected.fingerprint != expected.raw.fingerprint()
        {
            return Err(ErrorCode::OperationDenied);
        }
        let configured = self.configured_trust();
        if let Some(sources) = &configured {
            sources.enrollment_path()?;
            let current = sources.read(&self.host_label, deadline)?;
            if Some(current.stamp) != expected.trust_stamp {
                return Err(ErrorCode::HostKeyChanged);
            }
        }
        // The approved key must still be among the keys the server offers.
        let present = observe(deadline)?
            .into_iter()
            .find(|key| key == &expected.raw)
            .ok_or(ErrorCode::HostKeyChanged)?;
        self.revalidate_policy()?;
        let hash = self
            .policy
            .as_ref()
            .is_some_and(|policy| policy.hash_known_hosts);
        match configured {
            Some(sources) => trust_store::extended::approve(
                sources.enrollment_path()?,
                &sources.paths(),
                &self.host_label,
                &present,
                expected.trust_stamp.ok_or(ErrorCode::OperationDenied)?,
                hash,
                deadline,
            ),
            None => trust_store::approve(
                &self.config.known_hosts,
                &self.host_label,
                &present,
                hash,
                deadline,
            ),
        }
    }

    pub(super) fn host_verification(&self) -> HostVerification {
        self.policy
            .as_ref()
            .map_or_else(HostVerification::default, |policy| policy.host_verification)
    }

    pub(super) fn certificate_authority(
        &self,
        deadline: Instant,
    ) -> Result<trust_store::Pin, ErrorCode> {
        let policy = self.policy.as_ref().ok_or(ErrorCode::ConfigUnsupported)?;
        if policy.host_verification != HostVerification::Ed25519Certificate
            || policy.known_hosts.is_some()
            || policy.host_key_alias.is_none()
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let paths: Vec<_> = policy
            .global_known_hosts
            .iter()
            .map(PathBuf::as_path)
            .collect();
        trust_store::extended::read_certificate_authority(&paths, &self.host_label, deadline)?
            .ok_or(READ_ONLY)
    }

    pub(super) fn pin(&self) -> Result<Option<trust_store::Pin>, ErrorCode> {
        if self.host_verification() == HostVerification::Ed25519Certificate {
            return Err(ErrorCode::ConfigUnsupported);
        }
        if let Some(sources) = self.configured_trust() {
            return sources
                .read(&self.host_label, Instant::now() + DEADLINE)
                .map(|state| state.pin);
        }
        trust_store::read(&self.config.known_hosts, &self.host_label)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn routed_trust_stamp(
        &self,
        deadline: Instant,
    ) -> Result<(Option<host_key::HostKey>, [u8; 32]), ErrorCode> {
        self.revalidate_policy()?;
        let sources = self
            .configured_trust()
            .ok_or(ErrorCode::ConfigUnsupported)?;
        let inspection = sources.read(&self.host_label, deadline)?;
        Ok((inspection.pin.map(|pin| pin.key), inspection.stamp))
    }

    fn configured_trust(&self) -> Option<ConfiguredTrust<'_>> {
        let policy = self.policy.as_ref()?;
        Some(ConfiguredTrust {
            first_user: policy.known_hosts.as_deref(),
            other_user: &policy.additional_user_known_hosts,
            global: &policy.global_known_hosts,
        })
    }
}

struct ConfiguredTrust<'a> {
    first_user: Option<&'a Path>,
    other_user: &'a [PathBuf],
    global: &'a [PathBuf],
}

impl<'a> ConfiguredTrust<'a> {
    fn paths(&self) -> Vec<&'a Path> {
        self.first_user
            .into_iter()
            .chain(
                self.other_user
                    .iter()
                    .chain(self.global)
                    .map(PathBuf::as_path),
            )
            .collect()
    }

    fn enrollment_path(&self) -> Result<&'a Path, ErrorCode> {
        self.first_user.ok_or(READ_ONLY)
    }

    fn read(
        &self,
        label: &str,
        deadline: Instant,
    ) -> Result<trust_store::extended::Inspection, ErrorCode> {
        let state = trust_store::extended::read(&self.paths(), label, deadline)?;
        // No first-use challenge or network attempt for a host with no pin
        // when the effective policy has no approval destination.
        if state.pin.is_none() && self.first_user.is_none() {
            return Err(READ_ONLY);
        }
        Ok(state)
    }
}
