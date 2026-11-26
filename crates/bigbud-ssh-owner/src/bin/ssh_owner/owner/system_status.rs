//! W7 remote system stats (Request 180 `sample_system_status` / Reply 101).
//!
//! One fixed, read-only, owner-chosen recipe runs as a mux session over the
//! exact target's verified production master (the same path as
//! `terminal_inspect`): no second SSH connection, no PTY and no caller operand.
//! Output is bounded to 512 KiB and the session to the shared 5 s deadline.
//! The recipe reads kernel and user-visible metadata only; nothing on the
//! target is created or modified. CPU usage is derived by the consumer from two
//! successive samples, so the recipe never sleeps while holding the owner.

use super::super::{ErrorCode, Owner};
use crate::v1::SystemStatusSample;

const LIMIT: usize = 512 * 1024;
const END: &str = "###END###";
// Stderr is discarded on the target so a missing file never reaches the session.
const RECIPE: &str = r####"/bin/sh -c 'exec 2>/dev/null; PATH=/usr/bin:/bin:/usr/sbin:/sbin; LC_ALL=C; export PATH LC_ALL; printf "###OS###\n"; uname -s; printf "###HOST###\n"; uname -n; printf "###ARCH###\n"; uname -m; printf "###KERNEL###\n"; uname -r; printf "###CPU###\n"; head -n 65 /proc/stat; printf "###MEM###\n"; cat /proc/meminfo; printf "###UPTIME###\n"; cat /proc/uptime; printf "###DF###\n"; df -Pk; printf "###NET###\n"; cat /proc/net/dev; printf "###PROCESS###\n"; ps -eo pid=,ppid=,comm=,rss=,vsz=,stat=,etimes=,pcpu= --sort=-%cpu | head -n 1001; printf "###TEMP###\n"; for file in /sys/class/thermal/thermal_zone*/temp; do if [ -r "$file" ]; then printf "%s " "$file"; cat "$file"; fi; done; printf "###END###\n"'"####;

impl Owner {
    pub(in super::super) fn sample_system_status(
        &mut self,
    ) -> Result<SystemStatusSample, ErrorCode> {
        if !self.production {
            return Err(ErrorCode::OperationDenied);
        }
        let output = self.run_on_master(RECIPE, LIMIT)?;
        complete_sample(&output).ok_or(ErrorCode::WorkspaceReadFailed)
    }
}

/// A sample is complete only when the recipe reached its END marker.
fn complete_sample(output: &[u8]) -> Option<SystemStatusSample> {
    let sections = String::from_utf8_lossy(output).into_owned();
    sections
        .lines()
        .any(|line| line == END)
        .then_some(SystemStatusSample { sections })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_is_fixed_read_only_and_single_quoted() {
        // The whole recipe is one single-quoted `sh -c` operand: no other quote.
        assert_eq!(RECIPE.matches('\'').count(), 2);
        for forbidden in ["rm ", "mv ", "mkdir", "touch", "sleep", "tee ", ">>"] {
            assert!(!RECIPE.contains(forbidden), "{forbidden}");
        }
        // The only redirection discards stderr; nothing is written on the target.
        assert_eq!(RECIPE.matches('>').count(), 1);
        assert!(RECIPE.contains("exec 2>/dev/null;"));
        assert!(RECIPE.ends_with("###END###\\n\"'"));
    }

    #[test]
    fn requires_the_end_marker_and_keeps_lossy_text() {
        assert!(complete_sample(b"###OS###\nLinux\n").is_none());
        assert!(complete_sample(b"###OS###\nLinux\n###END###x\n").is_none());
        let sample = complete_sample(b"###HOST###\nh\xffst\n###END###\n");
        assert_eq!(
            sample.map(|sample| sample.sections),
            Some("###HOST###\nh\u{fffd}st\n###END###\n".to_owned())
        );
    }
}
