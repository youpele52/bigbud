use std::path::PathBuf;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub struct ProcessIdentity {
    pub pid: u32,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub same_user: bool,
}

/// Reads only the requested process and this inspector's user identity, without environment data.
pub fn inspect(pid: u32) -> Option<ProcessIdentity> {
    if pid == 0 {
        return None;
    }
    let target = Pid::from_u32(pid);
    let own = Pid::from_u32(std::process::id());
    let mut system = System::new();
    let pids = if target == own {
        vec![target]
    } else {
        vec![target, own]
    };
    let _updated = system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_exe(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_user(UpdateKind::Always),
    );
    let process = system.process(target)?;
    let inspector = system.process(own)?;
    let executable = process.exe()?.to_path_buf();
    if !executable.is_absolute() || process.cmd().len() > 32 {
        return None;
    }
    let arguments: Option<Vec<String>> = process
        .cmd()
        .iter()
        .map(|arg| {
            arg.to_str()
                .filter(|arg| arg.len() <= 4096)
                .map(str::to_owned)
        })
        .collect();
    Some(ProcessIdentity {
        pid,
        executable,
        arguments: arguments?,
        same_user: process.user_id().is_some()
            && process.user_id() == inspector.user_id()
            && process.effective_user_id().is_some()
            && process.effective_user_id() == inspector.effective_user_id(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn process_identity_rejects_zero() {
        assert!(super::inspect(0).is_none());
    }

    #[test]
    #[cfg(unix)]
    fn process_identity_reads_self() {
        let identity = super::inspect(std::process::id()).expect("self identity");
        assert!(identity.same_user);
        assert_eq!(
            identity.executable,
            std::env::current_exe().expect("executable")
        );
        assert!(!identity.arguments.is_empty());
    }
}
