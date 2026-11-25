use crate::transport::PinnedSsh;
use bigbud_ssh_owner::git_receive_gate::DestinationReceipt;
use std::io;
use std::mem::MaybeUninit;
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const CLEANUP_GRACE: Duration = Duration::from_millis(150);
const POLL: Duration = Duration::from_millis(5);

#[derive(Default)]
struct Children {
    git: Option<Child>,
    ssh: Option<(Child, PinnedSsh)>,
}

impl Children {
    fn each(&self) -> impl Iterator<Item = &Child> {
        self.git.iter().chain(self.ssh.iter().map(|(ssh, _)| ssh))
    }

    fn kill_groups(&mut self) {
        for child in self
            .git
            .iter_mut()
            .chain(self.ssh.iter_mut().map(|(ssh, _)| ssh))
        {
            if let Ok(pid) = i32::try_from(child.id()) {
                // SAFETY: each child was started as a process group leader.
                // Neither leader has been reaped; its reserved PID cannot be
                // recycled as another process group before this call.
                if unsafe { libc::kill(-pid, libc::SIGKILL) } != 0 {
                    // If there is no group left, the direct child may already
                    // be a zombie. The reaper, not signal success, confirms exit.
                    let _direct_child_signal = child.kill();
                }
            }
        }
    }

    fn reap(mut self) {
        if let Some(mut git) = self.git.take() {
            let _reaped_or_no_child = git.wait();
        }
        if let Some((mut ssh, _pin)) = self.ssh.take() {
            let _reaped_or_no_child = ssh.wait();
        }
    }
}

pub(super) struct Graph {
    children: Children,
    reaper: SyncSender<Children>,
}

impl Graph {
    pub(super) fn new(busy: Arc<AtomicBool>) -> io::Result<Self> {
        if busy.swap(true, Ordering::AcqRel) {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let reservation = Reservation(busy);
        let (reaper, next) = mpsc::sync_channel::<Children>(1);
        // Pre-arm exceptional cleanup. At most one graph or pending reaper
        // exists per launcher; an unreapable child never blocks the owner.
        thread::Builder::new()
            .name("fixture-push-reap".into())
            .spawn(move || {
                let _reservation = reservation;
                if let Ok(children) = next.recv() {
                    children.reap();
                }
            })?;
        Ok(Self {
            children: Children::default(),
            reaper,
        })
    }

    pub(super) fn set_git(&mut self, child: Child) {
        self.children.git = Some(child);
    }

    pub(super) fn set_ssh(&mut self, child: Child, pin: PinnedSsh) -> &mut Child {
        &mut self.children.ssh.insert((child, pin)).0
    }

    pub(super) fn children_running(&self) -> bool {
        self.children.git.is_some()
            && self.children.ssh.is_some()
            && self
                .children
                .each()
                .all(|child| matches!(exited(child), Ok(false)))
    }

    pub(super) fn retire(self, deadline: Instant, receipt: DestinationReceipt) {
        if receipt != DestinationReceipt::Unconfirmed {
            let until = deadline.min(Instant::now() + CLEANUP_GRACE);
            while self
                .children
                .each()
                .any(|child| matches!(exited(child), Ok(false)))
            {
                let left = until.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                thread::sleep(left.min(POLL));
            }
        }
        // Drop signals even if a leader exited, in case it left descendants.
    }
}

impl Drop for Graph {
    fn drop(&mut self) {
        self.children.kill_groups();
        let children = std::mem::take(&mut self.children);
        // The live receiver has exactly one sender and an empty slot. It
        // cannot reach reaping or exit until this send (or sender drop).
        let _transferred_to_reaper = self.reaper.send(children);
    }
}

struct Reservation(Arc<AtomicBool>);

impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn exited(child: &Child) -> io::Result<bool> {
    let mut metadata = MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: metadata is exclusive writable storage; P_PID selects only
    // our direct child, and WNOWAIT preserves its ID for group retirement.
    unsafe {
        if libc::waitid(
            libc::P_PID,
            child.id(),
            metadata.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(metadata.assume_init().si_pid() != 0)
    }
}
