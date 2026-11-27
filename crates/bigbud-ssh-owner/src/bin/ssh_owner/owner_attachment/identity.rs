//! Owner artifact identity for attach verification (v1.owner_shutdown.proto).
//!
//! SHA-256 over a domain tag, the canonical executable path and the SHA-256 of
//! the executable bytes, measured once at startup so a later in-place update of
//! the installed file cannot make a running old owner claim the new identity.

use std::{
    fs::File,
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::Token;

const DOMAIN: &[u8] = b"bigbud.ssh-owner.artifact.v1\0";

/// Measures this process's own executable image.
pub(crate) fn measure_self() -> io::Result<Token> {
    let (path, image) = own_image()?;
    identity(&path, image)
}

#[cfg(target_os = "linux")]
fn own_image() -> io::Result<(PathBuf, File)> {
    // `/proc/self/exe` is the running image even if the path was replaced; a
    // replaced or deleted path no longer canonicalizes to the install path.
    let path = std::fs::read_link("/proc/self/exe")?;
    Ok((path, File::open("/proc/self/exe")?))
}

#[cfg(not(target_os = "linux"))]
fn own_image() -> io::Result<(PathBuf, File)> {
    let path = std::fs::canonicalize(std::env::current_exe()?)?;
    let image = File::open(&path)?;
    Ok((path, image))
}

/// The identity of `image` installed at the canonical `path`.
pub(crate) fn identity(path: &Path, mut image: impl Read) -> io::Result<Token> {
    let mut bytes = Sha256::new();
    io::copy(&mut image, &mut bytes)?;
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update(path.as_os_str().as_bytes());
    digest.update([0]);
    digest.update(bytes.finalize());
    Ok(digest.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_binds_the_install_path_and_the_bytes() {
        let a = identity(Path::new("/opt/a/bigbud-ssh-owner"), &b"image"[..]).unwrap();
        let moved = identity(Path::new("/opt/b/bigbud-ssh-owner"), &b"image"[..]).unwrap();
        let rebuilt = identity(Path::new("/opt/a/bigbud-ssh-owner"), &b"other"[..]).unwrap();
        assert_ne!(a, moved);
        assert_ne!(a, rebuilt);
        assert_eq!(
            a,
            identity(Path::new("/opt/a/bigbud-ssh-owner"), &b"image"[..]).unwrap()
        );
    }

    #[test]
    fn measures_the_running_test_binary() {
        assert_eq!(measure_self().unwrap().len(), 32);
    }
}
