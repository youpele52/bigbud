//! The host policy loop (plan §8.5-§8.7, §7.3 item 9): one owned thread that ticks once a
//! second. Each tick collects the PTYs under a brief session lock, then probes, evaluates,
//! closes, checkpoints and rebuilds outside it. Memory is sampled every 10 s (tree RSS every
//! 30 s) and reported to owners. With `--exit-when-orphaned-and-empty`, a host with no live
//! PTY and no connected owner for 60 s terminates itself through the graceful SIGTERM path.

use super::host_runtime::HostRuntime;
use crate::AgentSession;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "policy_loop.memory.rs"]
mod memory;

const TICK: Duration = Duration::from_secs(1);
/// §7.3 item 9.
pub(super) const SELF_EXIT_AFTER: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default)]
pub struct SupervisorOptions {
    /// `--exit-when-orphaned-and-empty`.
    pub exit_when_orphaned_and_empty: bool,
}

pub(super) fn spawn(
    sessions: Arc<Mutex<AgentSession>>,
    runtime: Arc<HostRuntime>,
    options: SupervisorOptions,
) -> io::Result<()> {
    std::thread::Builder::new()
        .name("terminal-policy".to_owned())
        .spawn(move || run(&sessions, &runtime, options))
        .map(|_detached| ())
}

/// Debug builds only: shortens the self-exit delay for real-process tests.
#[cfg(debug_assertions)]
const SELF_EXIT_OVERRIDE_ENV: &str = "BIGBUD_DEBUG_TERMINAL_HOST_SELF_EXIT_MS";

fn self_exit_after() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var(SELF_EXIT_OVERRIDE_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    SELF_EXIT_AFTER
}

/// Diagnostics (any build): with this set to a period in ms (≥ 1000), the loop writes one
/// `terminal host stats:` line to stderr (`supervisor.log`) per period, for the Q1 soak harness.
const STATS_ENV: &str = "BIGBUD_DEBUG_TERMINAL_HOST_STATS_MS";

fn stats_every() -> Option<Duration> {
    std::env::var(STATS_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|ms| *ms >= 1_000)
        .map(Duration::from_millis)
}

fn run(sessions: &Mutex<AgentSession>, runtime: &HostRuntime, options: SupervisorOptions) {
    let mut sampler = memory::Sampler::new();
    let exit_after = self_exit_after();
    let stats = stats_every();
    let mut stats_at = Instant::now();
    let mut empty_since: Option<Instant> = None;
    loop {
        std::thread::sleep(TICK);
        if let Some(every) = stats
            && stats_at.elapsed() >= every
        {
            stats_at = Instant::now();
            let Ok((live, roots)) = sessions
                .lock()
                .map(|mut session| (session.live_pty_count(), session.workspace_root_count()))
            else {
                return;
            };
            eprintln!(
                "terminal host stats: live_ptys={live} workspace_roots={roots} owners={}",
                runtime.host.owners()
            );
        }
        let Ok(ptys) = sessions.lock().map(|mut session| session.lifecycle_ptys()) else {
            return;
        };
        let closed = runtime.host.run_policy(&ptys);
        if !closed.is_empty() {
            let Ok(mut session) = sessions.lock() else {
                return;
            };
            for pty_id in &closed {
                session.note_pty_closed(pty_id);
            }
        }
        sampler.tick(&runtime.host, &ptys);
        drop(ptys);
        if options.exit_when_orphaned_and_empty {
            let Ok(live) = sessions.lock().map(|mut session| session.live_pty_count()) else {
                return;
            };
            if live == 0 && runtime.host.owners() == 0 {
                let since = *empty_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= exit_after {
                    eprintln!("terminal host exiting: no terminals and no owner");
                    request_termination();
                    return;
                }
            } else {
                empty_since = None;
            }
        }
    }
}

/// Routes self-exit through the existing graceful termination (the SIGTERM self-pipe).
fn request_termination() {
    // SAFETY: kill on this process's own PID with a handled signal has no memory effects.
    let result = unsafe { libc::kill(libc::getpid(), libc::SIGTERM) };
    if result != 0 {
        eprintln!(
            "terminal host self-exit signal failed: {}",
            io::Error::last_os_error()
        );
    }
}
