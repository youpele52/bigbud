use std::{
    io,
    num::NonZeroU32,
    path::{Path, PathBuf},
};

/// Filesystem object identity (device + inode, symlinks followed). Matches
/// one object under any of its names (symlinks, firmlinks such as the
/// Cryptex-hosted `/Applications/Safari.app`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
}

/// `None` when the path cannot be stat'ed (or off Unix).
pub fn file_identity(path: &Path) -> Option<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|metadata| FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleIdentity {
    /// The `.app` directory whose `Contents/MacOS/` holds the executable.
    pub path: PathBuf,
    /// `CFBundleIdentifier`, when the bundle declares a valid one. A bundle
    /// without one is never permitted (a bundle-id restriction could not
    /// be checked).
    pub identifier: Option<String>,
    pub file: Option<FileIdentity>,
}

/// Identity observed by the owner for one live process. `creation` is the
/// native creation identity (pid reuse changes it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedApp {
    pub pid: NonZeroU32,
    pub creation: String,
    pub executable: PathBuf,
    pub executable_file: Option<FileIdentity>,
    pub bundle: Option<BundleIdentity>,
}

/// Resolves a live pid to its verified identity, or fails (never guesses).
pub trait IdentitySource {
    fn resolve(&self, pid: NonZeroU32) -> io::Result<VerifiedApp>;
}

/// The innermost `X.app` such that `executable` is `X.app/Contents/MacOS/<file>`.
/// Structural only: a helper app nested in another app is its own bundle; it
/// is grouped with the outer app only by separate owning-app evidence.
pub fn enclosing_bundle(executable: &Path) -> Option<PathBuf> {
    let file = executable.file_name()?;
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    (!file.is_empty()
        && macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && is_app)
        .then(|| bundle.to_path_buf())
}

/// Any ancestor directory is an `.app` bundle. An executable inside a bundle
/// that is not its structural main executable cannot be attributed to that
/// bundle's identifier, so it is unverified rather than unbundled.
pub fn inside_app_bundle(executable: &Path) -> bool {
    executable.ancestors().skip(1).any(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    })
}

/// A bundle identifier must be reverse-DNS-like printable ASCII, bounded.
pub(super) fn valid_bundle_identifier(value: &str) -> bool {
    (1..=255).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}
