use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

use super::SessionError;

// Mirrors ShellProfiles.candidates.ts and ShellProfiles.remote.protocol.ts. The
// focused policy test guards drift. Inventory never resolves the final file symlink.
const ROOTS: [&str; 4] = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const NAMES: [&str; 5] = ["zsh", "bash", "fish", "sh", "pwsh"];

fn denied() -> SessionError {
    SessionError::Pty("Unsupported or unavailable exact shell profile".to_owned())
}

pub(super) fn validate(shell: &str, args: &[String]) -> Result<(), SessionError> {
    validate_with(shell, args, std::env::consts::OS, |path| fs::metadata(path))
}

pub(super) fn validate_with(
    shell: &str,
    args: &[String],
    platform: &str,
    metadata: impl FnOnce(&Path) -> io::Result<Metadata>,
) -> Result<(), SessionError> {
    if !matches!(platform, "linux" | "macos") {
        return Err(denied());
    }
    let name = NAMES
        .iter()
        .find(|name| {
            ROOTS.iter().any(|root| {
                if shell == format!("{root}/{name}") {
                    return true;
                }
                // The inventory uses cd -P for directories, retaining file symlinks.
                // Permit that physical spelling too (e.g. a symlinked system bin).
                fs::canonicalize(root).is_ok_and(|physical| {
                    physical
                        .join(name)
                        .to_str()
                        .is_some_and(|path| path == shell)
                })
            })
        })
        .ok_or_else(denied)?;
    let expected: &[&str] = if *name == "zsh" {
        &["-o", "nopromptsp"]
    } else {
        &[]
    };
    if !args.iter().map(String::as_str).eq(expected.iter().copied()) {
        return Err(denied());
    }
    let file = metadata(Path::new(shell)).map_err(|_| denied())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !file.is_file() || file.permissions().mode() & 0o111 == 0 {
            return Err(denied());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Err(denied())
    }
}

#[cfg(all(test, unix))]
#[path = "pty_profile.tests.rs"]
mod tests;
