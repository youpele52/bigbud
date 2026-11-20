//! Fixed local upstream attachment. The address comes only from validated
//! configuration, never from the request, so the gateway cannot be used to
//! reach arbitrary destinations.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::config::Upstream;

/// Any byte stream usable by hyper (via `TokioIo`) and tungstenite.
pub trait UpstreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> UpstreamIo for T {}

pub type UpstreamStream = Box<dyn UpstreamIo>;

pub async fn connect_upstream(
    upstream: &Upstream,
    timeout: Duration,
) -> io::Result<UpstreamStream> {
    match upstream {
        Upstream::Tcp(address) => {
            let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address))
                .await
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
            stream.set_nodelay(true)?;
            Ok(Box::new(stream))
        }
        #[cfg(unix)]
        Upstream::Unix(path) => {
            ensure_owner_only_socket(path)?;
            let stream = tokio::time::timeout(timeout, tokio::net::UnixStream::connect(path))
                .await
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
            Ok(Box::new(stream))
        }
    }
}

/// Refuses sockets that other local users could also have created or opened.
#[cfg(unix)]
fn ensure_owner_only_socket(path: &std::path::Path) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "upstream socket is not an owner-only socket",
        ));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn refuses_group_accessible_unix_sockets() {
        let dir = std::env::temp_dir().join(format!("bigbud-gw-sock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backend.sock");
        let _listener = tokio::net::UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let upstream = Upstream::Unix(path.clone());
        let error = connect_upstream(&upstream, Duration::from_secs(1))
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            connect_upstream(&upstream, Duration::from_secs(1))
                .await
                .is_ok()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
