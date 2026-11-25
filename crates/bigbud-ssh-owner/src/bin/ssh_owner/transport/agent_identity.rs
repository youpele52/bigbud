//! Opt-in local authentication for the Unix loopback proof, not agent forwarding.

use super::{ErrorCode, ResolvedConfig, Transport, identity};
use crate::config::IdentityAgent;
use std::fs::{self, Metadata};
use std::os::unix::{
    fs::{FileTypeExt, MetadataExt},
    net::SocketAddr,
};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(test)]
#[path = "agent_identity_tests.rs"]
mod tests;

const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;

pub(super) struct ProofAgent {
    path: PathBuf,
    stamp: PathStamp,
}

impl Transport {
    /// A trusted startup hint may fill an absent setting, but must never
    /// override a disabled setting or replace the explicitly selected socket.
    pub(in super::super) fn bind_proof_agent(&mut self, path: &Path) -> Result<(), ErrorCode> {
        match self.policy.as_ref().map(|policy| &policy.identity_agent) {
            Some(IdentityAgent::Disabled) => Ok(()),
            Some(IdentityAgent::Socket(configured)) => {
                if configured.as_os_str() != path.as_os_str() {
                    return Err(UNSUPPORTED);
                }
                self.revalidate_proof_agent()
            }
            Some(IdentityAgent::Absent) | None if self.proof_agent.is_none() => {
                self.proof_agent = Some(ProofAgent::bind(path)?);
                Ok(())
            }
            Some(IdentityAgent::Absent) | None => Err(UNSUPPORTED),
        }
    }

    pub(super) fn revalidate_proof_agent(&self) -> Result<(), ErrorCode> {
        if let Some(agent) = &self.proof_agent
            && PathStamp::read(&agent.path)? != agent.stamp
        {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }

    pub(super) fn apply_proof_agent(&self, ssh: &mut Command) -> Result<(), ErrorCode> {
        self.revalidate_proof_agent()?;
        let option = self.proof_agent.as_ref().map_or_else(
            || "IdentityAgent=none".to_owned(),
            |agent| format!("IdentityAgent={}", agent.path.display()),
        );
        ssh.env_remove("SSH_AUTH_SOCK").arg("-o").arg(option);
        Ok(())
    }
}

impl ProofAgent {
    pub(super) fn from_policy(policy: Option<&ResolvedConfig>) -> Result<Option<Self>, ErrorCode> {
        match policy.map(|policy| &policy.identity_agent) {
            Some(IdentityAgent::Socket(path)) => Self::bind(path).map(Some),
            Some(IdentityAgent::Absent | IdentityAgent::Disabled) | None => Ok(None),
        }
    }

    fn bind(path: &Path) -> Result<Self, ErrorCode> {
        let bytes = path.as_os_str().as_encoded_bytes();
        let relative = bytes.strip_prefix(b"/").ok_or(UNSUPPORTED)?;
        if !identity::literal_path(path)
            || relative
                .split(|&byte| byte == b'/')
                .any(|part| part.is_empty() || matches!(part, b"." | b".."))
        {
            return Err(UNSUPPORTED);
        }
        // Reject paths that cannot be Unix socket addresses on this platform.
        SocketAddr::from_pathname(path).map_err(|_| UNSUPPORTED)?;
        let stamp = PathStamp::read(path)?;
        Ok(Self {
            path: path.to_owned(),
            stamp,
        })
    }
}

#[derive(PartialEq, Eq)]
struct PathStamp {
    parents: Vec<NodeStamp>,
    socket: NodeStamp,
    changed: (i64, i64),
}

impl PathStamp {
    fn read(path: &Path) -> Result<Self, ErrorCode> {
        // SAFETY: geteuid takes no arguments and observes only the current process.
        let uid = unsafe { libc::geteuid() };
        let parent = path.parent().ok_or(UNSUPPORTED)?;
        let ancestors: Vec<_> = parent.ancestors().collect();
        let mut parents = Vec::with_capacity(ancestors.len());
        // Check from the root so a substituted symlink is rejected, not followed.
        // The owner and root are trusted; no other user may replace a component.
        for dir in ancestors.into_iter().rev() {
            let meta = fs::symlink_metadata(dir).map_err(|_| UNSUPPORTED)?;
            let root_sticky = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
            if !meta.is_dir()
                || if dir == parent {
                    meta.uid() != uid || meta.mode() & 0o7777 != 0o700
                } else {
                    (meta.uid() != 0 && meta.uid() != uid)
                        || (meta.mode() & 0o022 != 0 && !root_sticky)
                }
            {
                return Err(UNSUPPORTED);
            }
            parents.push(NodeStamp::of(&meta));
        }
        let meta = fs::symlink_metadata(path).map_err(|_| UNSUPPORTED)?;
        if !meta.file_type().is_socket()
            || meta.uid() != uid
            || meta.mode() & 0o7777 != 0o600
            || meta.nlink() != 1
        {
            return Err(UNSUPPORTED);
        }
        Ok(Self {
            parents,
            socket: NodeStamp::of(&meta),
            changed: (meta.ctime(), meta.ctime_nsec()),
        })
    }
}

#[derive(PartialEq, Eq)]
struct NodeStamp {
    file: (u64, u64),
    uid: u32,
    mode: u32,
}

impl NodeStamp {
    fn of(meta: &Metadata) -> Self {
        Self {
            file: (meta.dev(), meta.ino()),
            uid: meta.uid(),
            mode: meta.mode(),
        }
    }
}
