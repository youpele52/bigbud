//! Immutable original lease identity. No PID can stand in for an execution token.
use super::{Error, Result};
#[cfg(any(unix, test))]
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Binding {
    pub authority: String,
    pub installation: String,
    pub native_epoch: String,
    pub nonce: String,
    pub publication_sha256: [u8; 32],
    pub executable_sha256: [u8; 32],
    pub assets_sha256: [u8; 32],
    pub configuration_sha256: [u8; 32],
    pub guard_sha256: [u8; 32],
}
impl Binding {
    #[cfg(any(unix, test))]
    pub(super) fn validate(&self) -> Result<()> {
        if self.authority.len() != 32
            || !self
                .authority
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !self.installation.starts_with("sha256:")
            || self.installation.len() != 71
            || !self
                .installation
                .get(7..)
                .ok_or(Error::Invalid)?
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !bounded_label(&self.native_epoch)
            || !bounded_label(&self.nonce)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
#[cfg(any(unix, test))]
fn bounded_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// Original backend process identity, including boot and kernel start ticks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Controller {
    pub pid: u32,
    pub boot: String,
    pub started: String,
}
impl Controller {
    pub fn current() -> Result<Self> {
        Self::read(std::process::id())
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn read(pid: u32) -> Result<Self> {
        use std::io::Read;
        if pid <= 1 {
            return Err(Error::Invalid);
        }
        let mut stat = String::new();
        std::fs::File::open(format!("/proc/{pid}/stat"))?
            .take(8193)
            .read_to_string(&mut stat)?;
        if stat.len() > 8192 {
            return Err(Error::Invalid);
        }
        let (_, fields) = stat.rsplit_once(") ").ok_or(Error::Invalid)?;
        let started = fields.split_whitespace().nth(19).ok_or(Error::Invalid)?;
        if started.is_empty() || !started.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::Invalid);
        }
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid only reads our actual account identity.
        if std::fs::metadata(format!("/proc/{pid}"))?.uid() != unsafe { libc::geteuid() } {
            return Err(Error::Refused);
        }
        let mut boot = String::new();
        std::fs::File::open("/proc/sys/kernel/random/boot_id")?
            .take(65)
            .read_to_string(&mut boot)?;
        if boot.len() > 64 || boot.trim().is_empty() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            pid,
            boot: boot.trim().to_owned(),
            started: started.to_owned(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn read(_pid: u32) -> Result<Self> {
        Err(Error::Unsupported)
    }

    /// An unreadable process is uncertain, never dead. A missing process or a
    /// changed kernel identity proves this exact former controller is absent.
    #[cfg(unix)]
    pub(super) fn dead(&self) -> Result<bool> {
        match Self::read(self.pid) {
            Ok(current) => Ok(current != *self),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(error),
        }
    }
}

#[cfg(any(unix, test))]
pub(super) fn capability_hash(capability: &[u8]) -> Result<[u8; 32]> {
    if !(32..=64).contains(&capability.len()) {
        return Err(Error::Invalid);
    }
    Ok(Sha256::digest(capability).into())
}
#[cfg(any(unix, test))]
pub(super) fn capability_matches(expected: &[u8; 32], supplied: &[u8]) -> bool {
    match capability_hash(supplied) {
        Ok(actual) => {
            expected
                .iter()
                .zip(actual)
                .fold(0, |diff, (a, b)| diff | (a ^ b))
                == 0
        }
        Err(_) => false,
    }
}
