use std::io;
use std::time::{Duration, Instant};

#[path = "child.session.process.rs"]
mod process;
use process::{Identity, Process};

const MAX_PROC_ENTRIES: usize = 65_536;
const MAX_MEMBERS: usize = 1024;
const SCAN_BUDGET: Duration = Duration::from_millis(100);
const RESCAN_INTERVAL: Duration = Duration::from_millis(50);

/// The caller holds the Child authority permit and keeps its direct session
/// leader unreaped until this observation settles. Session IDs therefore cannot
/// be reused. Detached/new-session daemons are outside this terminal's scope.
pub(super) struct Session {
    members: Vec<Process>,
    signal: i32,
    last_scan: Option<Instant>,
    empty_scan: bool,
}

impl Session {
    pub fn new() -> Self {
        Self {
            members: Vec::new(),
            signal: 0, // Natural leader exit observes jobs without terminating them.
            last_scan: None,
            empty_scan: false,
        }
    }

    pub fn signal(&mut self, leader: i32, signal: i32) -> io::Result<()> {
        // Once forced, a repeated graceful close cannot weaken escalation.
        if self.signal != libc::SIGKILL && self.signal != signal {
            self.signal = signal;
            self.empty_scan = false;
            self.last_scan = None;
        }
        // The failed-setup cleanup owner repeats KILL while polling. Repeating
        // the same request must not restart the two-observation settlement fence.
        self.discover(leader)?;
        for member in &mut self.members {
            member.request(self.signal)?;
        }
        // Signal the leader last, after retaining all observed job identities.
        // SAFETY: the caller's exclusive unreaped direct-child permit prevents
        // PID reuse, including forkpty's early pre-session setup failure path.
        if unsafe { libc::kill(leader, self.signal) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn settled(&mut self, leader: i32) -> io::Result<bool> {
        self.observe_settlement(leader, || {})
    }

    // The observation hook lets tests deterministically exercise exit/fork
    // between discovery and pidfd polling. Production performs no extra work.
    fn observe_settlement(
        &mut self,
        leader: i32,
        after_discovery: impl FnOnce(),
    ) -> io::Result<bool> {
        if self
            .last_scan
            .is_some_and(|at| at.elapsed() < RESCAN_INTERVAL)
        {
            return Ok(false);
        }
        self.last_scan = Some(Instant::now());
        let previously_empty = self.empty_scan;
        self.empty_scan = false;
        // Observe without reaping: the leader must no longer be able to fork,
        // but its PID/SID must remain reserved throughout session discovery.
        let exited = leader_exited(leader)?;
        let activity = self.discover(leader)?;
        after_discovery();
        let mut alive = false;
        for member in &mut self.members {
            if !member.exited()? {
                alive = true;
                if self.signal != 0 {
                    member.request(self.signal)?;
                }
            }
        }
        // A newly pinned member was live during this scan. Even if it has
        // exited now, it could have forked after enumeration passed its child.
        // This is not an empty observation and cannot complete the prior fence.
        let empty = exited && !alive && !activity;
        let settled = empty && previously_empty;
        self.empty_scan = empty;
        Ok(settled)
    }

    fn discover(&mut self, leader: i32) -> io::Result<bool> {
        self.prune()?;
        let started = Instant::now();
        let mut additions = Vec::new();
        for (count, entry) in std::fs::read_dir("/proc")?.enumerate() {
            if count >= MAX_PROC_ENTRIES || started.elapsed() >= SCAN_BUDGET {
                return Err(io::Error::other("PTY session discovery bound exceeded"));
            }
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if pid <= 0 || pid == leader {
                continue;
            }
            let identity = match Identity::read(pid) {
                Ok(identity) => identity,
                Err(error) if process::vanished(&error) => continue,
                Err(error) => return Err(error),
            };
            if identity.session != leader || self.members.iter().any(|p| p.identity == identity) {
                continue;
            }
            if self.members.len() + additions.len() >= MAX_MEMBERS {
                return Err(io::Error::other("PTY session member bound exceeded"));
            }
            if let Some(process) = Process::open(identity)? {
                additions.push(process);
            }
        }
        let activity = !additions.is_empty();
        if activity {
            self.empty_scan = false;
        }
        self.members.extend(additions);
        Ok(activity)
    }

    fn prune(&mut self) -> io::Result<()> {
        // Inspect before mutation so one failed observation cannot drop other
        // pinned identities, including a member which has since changed SID.
        let exited = self
            .members
            .iter()
            .map(Process::exited)
            .collect::<io::Result<Vec<_>>>()?;
        for (index, dead) in exited.into_iter().enumerate().rev() {
            if dead {
                self.members.remove(index);
            }
        }
        Ok(())
    }
}

pub(super) fn leader_exited(pid: i32) -> io::Result<bool> {
    // SAFETY: zero is a valid initial siginfo_t; waitid writes this storage.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: caller serializes the owned direct child's wait operations. WNOWAIT
    // observes exit without releasing its PID; only Child::poll performs reap.
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } == -1
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful waitid initialized the child-status siginfo layout.
    Ok(unsafe { info.si_pid() } == pid)
}

#[cfg(test)]
#[path = "child.session.tests.rs"]
mod tests;
