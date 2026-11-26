//! This process's PID and start time for `AgentHello` (plan §7.3 item 3). The desktop records
//! both and verifies them with `LC_ALL=C ps -o lstart= -p <pid>` (1 s tolerance) before it ever
//! signals the PID. The start time is milliseconds since the Unix epoch; 0 means unknown.

/// `(process_id, process_start_time_ms)`, computed once per process.
pub(super) fn current() -> (u64, u64) {
    static IDENTITY: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
    *IDENTITY.get_or_init(|| (u64::from(std::process::id()), start_time_ms().unwrap_or(0)))
}

#[cfg(target_os = "macos")]
fn start_time_ms() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` is a writable buffer of exactly `size` bytes for PROC_PIDTBSDINFO, and
    // the call only fills it for this process's own PID.
    let written = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: proc_pidinfo reported filling the whole struct.
    let info = unsafe { info.assume_init() };
    info.pbi_start_tvsec
        .checked_mul(1_000)?
        .checked_add(info.pbi_start_tvusec / 1_000)
}

#[cfg(target_os = "linux")]
fn start_time_ms() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let boot = std::fs::read_to_string("/proc/stat").ok()?;
    // SAFETY: sysconf has no preconditions and reports failure as -1.
    let ticks = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok()?;
    linux_start_time_ms(&stat, &boot, ticks)
}

/// Field 22 of `/proc/<pid>/stat` (clock ticks after boot) plus `btime` from `/proc/stat`.
#[cfg(any(target_os = "linux", test))]
fn linux_start_time_ms(stat: &str, boot: &str, ticks_per_second: u64) -> Option<u64> {
    // The command name may contain spaces and parentheses; fields resume after the last ')'.
    let fields = stat.get(stat.rfind(')')?.checked_add(1)?..)?;
    let start_ticks = fields.split_whitespace().nth(19)?.parse::<u64>().ok()?;
    let boot_seconds = boot
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse::<u64>()
        .ok()?;
    if ticks_per_second == 0 {
        return None;
    }
    boot_seconds
        .checked_mul(1_000)?
        .checked_add(start_ticks.checked_mul(1_000)? / ticks_per_second)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn start_time_ms() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_stat_parsing_handles_spaced_command_names() {
        let stat = "42 (my (odd) cmd) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 250 1000";
        let boot = "cpu  1 2 3\nbtime 1700000000\nprocesses 9\n";
        assert_eq!(
            linux_start_time_ms(stat, boot, 100),
            Some(1_700_000_000_000 + 2_500)
        );
        assert_eq!(linux_start_time_ms("garbage", boot, 100), None);
    }

    #[test]
    fn this_process_reports_its_pid_and_a_plausible_start_time() {
        let (pid, started) = current();
        assert_eq!(pid, u64::from(std::process::id()));
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            assert!(started > 0 && started <= now, "{started} vs {now}");
            assert!(now - started < 24 * 60 * 60 * 1000);
        }
    }
}
