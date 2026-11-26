use std::{io, time::Duration};

const PREFIX: &str = r"\\.\pipe\bigbud-ssh-owner-";
const MAX_WAIT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(10);

/// A local-only endpoint name. This is an address, not a credential or proof of ownership.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PipeName(String);

impl PipeName {
    pub(super) fn from_random_bytes(bytes: [u8; 16]) -> Self {
        use std::fmt::Write as _;
        let mut name = String::with_capacity(PREFIX.len() + 32);
        name.push_str(PREFIX);
        for byte in bytes {
            // Formatting into a String cannot fail.
            let _ = write!(name, "{byte:02x}");
        }
        Self(name)
    }

    pub fn parse(name: &str) -> io::Result<Self> {
        let valid = name.strip_prefix(PREFIX).is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        });
        if !valid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid owner pipe name",
            ));
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub(super) fn validate_timeout(timeout: Duration) -> io::Result<()> {
    if timeout.is_zero() || timeout > MAX_WAIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid owner pipe timeout",
        ));
    }
    Ok(())
}

pub(super) fn remaining(timeout: Duration, elapsed: Duration) -> io::Result<Duration> {
    timeout
        .checked_sub(elapsed)
        .filter(|left| !left.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "owner pipe deadline expired"))
}

/// A single budget covers retries and verification. Operations supplied here
/// must themselves be nonblocking (apart from the explicit sleep).
pub(super) fn within<T>(
    timeout: Duration,
    elapsed: impl Fn() -> Duration,
    mut sleep: impl FnMut(Duration),
    mut attempt: impl FnMut() -> io::Result<Option<T>>,
) -> io::Result<T> {
    validate_timeout(timeout)?;
    let remaining = || remaining(timeout, elapsed());
    loop {
        remaining()?;
        if let Some(value) = attempt()? {
            remaining()?;
            return Ok(value);
        }
        sleep(remaining()?.min(POLL));
    }
}

pub(super) fn verify_pid(
    pid: u32,
    expected: u32,
    still_bound: impl FnOnce() -> io::Result<u32>,
) -> io::Result<()> {
    if pid != 0 && pid == expected && still_bound()? == pid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "owner pipe peer rejected",
        ))
    }
}

#[cfg(test)]
mod tests;
