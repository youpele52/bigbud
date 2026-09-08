use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, thiserror::Error)]
pub enum AgentStateError {
    #[error("remote agent supervisor is already running")]
    AlreadyRunning,
    #[error("agent state path is a symlink")]
    Symlink,
    #[error("agent state path is not a directory")]
    NotDirectory,
    #[error("agent state path is not owned by the current user")]
    WrongOwner,
    #[error("agent state path is accessible by group or other users")]
    InsecurePermissions,
    #[error("agent state I/O failed: {0}")]
    Io(#[source] io::Error),
    #[error("system clock is before Unix epoch")]
    ClockBeforeUnixEpoch(#[source] std::time::SystemTimeError),
}

#[derive(Debug, Clone)]
pub struct AgentState {
    root: PathBuf,
    epoch: String,
}

impl AgentState {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, AgentStateError> {
        let root = root.as_ref().to_path_buf();
        if root.exists() {
            assert_secure_directory(&root)?;
        } else {
            fs::create_dir_all(&root).map_err(AgentStateError::Io)?;
            set_private_permissions(&root)?;
        }
        let epoch = format_epoch()?;
        let temporary = root.join(format!(".epoch.{}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(AgentStateError::Io)?;
        file.write_all(epoch.as_bytes())
            .map_err(AgentStateError::Io)?;
        file.sync_all().map_err(AgentStateError::Io)?;
        set_private_permissions(&temporary)?;
        fs::rename(&temporary, root.join("epoch")).map_err(AgentStateError::Io)?;
        Ok(Self { root, epoch })
    }

    #[cfg(unix)]
    pub fn open_for_supervisor(root: impl AsRef<Path>) -> Result<Self, AgentStateError> {
        let root = root.as_ref().to_path_buf();
        if root.exists() {
            assert_secure_directory(&root)?;
        }
        let socket = supervisor_socket_path(&root);
        if let Ok(metadata) = fs::symlink_metadata(&socket) {
            assert_secure_socket(&metadata)?;
            if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
                return Err(AgentStateError::AlreadyRunning);
            }
            fs::remove_file(&socket).map_err(AgentStateError::Io)?;
        }
        Self::open(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn operation_journal_path(&self) -> PathBuf {
        self.root.join("operations.journal")
    }
}

#[cfg(unix)]
fn assert_secure_socket(metadata: &fs::Metadata) -> Result<(), AgentStateError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    if metadata.file_type().is_symlink() {
        return Err(AgentStateError::Symlink);
    }
    if !metadata.file_type().is_socket() {
        return Err(AgentStateError::NotDirectory);
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(AgentStateError::WrongOwner);
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(AgentStateError::InsecurePermissions);
    }
    Ok(())
}

pub fn supervisor_socket_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join("supervisor.sock")
}

fn format_epoch() -> Result<String, AgentStateError> {
    format_epoch_at(SystemTime::now())
}

fn format_epoch_at(now: SystemTime) -> Result<String, AgentStateError> {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .map_err(AgentStateError::ClockBeforeUnixEpoch)
}

fn assert_secure_directory(path: &Path) -> Result<(), AgentStateError> {
    let symlink_metadata = fs::symlink_metadata(path).map_err(AgentStateError::Io)?;
    if symlink_metadata.file_type().is_symlink() {
        return Err(AgentStateError::Symlink);
    }
    if !symlink_metadata.is_dir() {
        return Err(AgentStateError::NotDirectory);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if symlink_metadata.uid() != unsafe { libc::getuid() as u32 } {
            return Err(AgentStateError::WrongOwner);
        }
        if symlink_metadata.mode() & 0o077 != 0 {
            return Err(AgentStateError::InsecurePermissions);
        }
    }
    Ok(())
}

fn set_private_permissions(path: &Path) -> Result<(), AgentStateError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(AgentStateError::Io)?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).map_err(AgentStateError::Io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn creates_private_state_and_rotates_epoch() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bigbud-state-{suffix}"));
        let state = AgentState::open(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("epoch")).unwrap(),
            state.epoch()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_state_path() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let target = std::env::temp_dir().join(format!("bigbud-state-target-{suffix}"));
        let link = std::env::temp_dir().join(format!("bigbud-state-link-{suffix}"));
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(
            AgentState::open(&link),
            Err(AgentStateError::Symlink)
        ));
        let _ = fs::remove_file(link);
        let _ = fs::remove_dir_all(target);
    }

    #[test]
    fn rejects_a_clock_before_unix_epoch() {
        assert!(matches!(
            format_epoch_at(UNIX_EPOCH - std::time::Duration::from_secs(1)),
            Err(AgentStateError::ClockBeforeUnixEpoch(_))
        ));
    }
}
