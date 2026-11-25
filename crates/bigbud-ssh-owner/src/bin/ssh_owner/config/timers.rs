use super::{ErrorCode, UNSUPPORTED};
use std::num::NonZeroU32;
use std::process::Command;
use std::time::Duration;

const DEFAULT_ALIVE_COUNT: u64 = 3;

#[derive(Default)]
pub(crate) struct SshTimers {
    pub(super) connect: Option<NonZeroU32>,
    pub(super) interval: Option<NonZeroU32>,
    pub(super) count: Option<NonZeroU32>,
}

impl SshTimers {
    pub(super) fn set(slot: &mut Option<NonZeroU32>, value: &str) -> Result<(), ErrorCode> {
        // Validate even shadowed active directives, like the other scalars.
        // Accept only positive decimal integers in OpenSSH's signed range.
        if !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(UNSUPPORTED);
        }
        let parsed = value.parse::<NonZeroU32>().map_err(|_| UNSUPPORTED)?;
        if i32::try_from(parsed.get()).is_err() {
            return Err(UNSUPPORTED);
        }
        slot.get_or_insert(parsed);
        Ok(())
    }

    pub(crate) fn apply_to(&self, ssh: &mut Command, budget: Duration) -> Result<(), ErrorCode> {
        let seconds = budget.as_secs();
        // Leave at least one whole second between configured SSH timers and
        // the picker watchdog. The watchdog still owns the end-to-end deadline.
        let cap = seconds.saturating_sub(1);
        if cap < 2 {
            return Err(ErrorCode::ListTimedOut);
        }
        let connect = self
            .connect
            .map_or(seconds, |n| u64::from(n.get()).min(cap));
        ssh.args(["-o", &format!("ConnectTimeout={connect}")]);
        if let Some(interval) = self.interval {
            // Reserve one extra interval: OpenSSH can disconnect on the check
            // after the maximum unanswered probes, not on the last probe itself.
            let interval = u64::from(interval.get()).min(cap / 2);
            let count = self
                .count
                .map_or(DEFAULT_ALIVE_COUNT, |n| u64::from(n.get()))
                .min(cap / interval - 1);
            ssh.args(["-o", &format!("ServerAliveInterval={interval}")]);
            ssh.args(["-o", &format!("ServerAliveCountMax={count}")]);
        } else if let Some(count) = self.count {
            // A count on its own does not opt in to keepalive probes.
            let count = u64::from(count.get()).min(cap - 1);
            ssh.args(["-o", &format!("ServerAliveCountMax={count}")]);
        }
        Ok(())
    }
}
