//! cgroup v2, PSI and meminfo parsing against fixture directories (R3).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::LinuxMemorySource;
use super::linux::{meminfo_bytes, psi_some_avg10};
use crate::terminal_policy::pressure::{MemoryThresholds, PressureLevel, classify};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

struct Fixture(PathBuf);

impl Fixture {
    fn new(label: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bigbud-memory-{label}-{suffix}"));
        let fixture = Self(root);
        fixture.write(
            "proc/meminfo",
            "MemTotal:       16777216 kB\nMemFree:  1 kB\nMemAvailable:    8388608 kB\n",
        );
        fixture.write("proc/pressure/memory", "some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=1\n");
        fixture.write("proc/self/statm", "1000 250 100 1 0 300 0\n");
        fixture
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn cgroup(&self, cgroup_path: &str) {
        self.write("proc/self/cgroup", &format!("0::{cgroup_path}\n"));
        self.write(
            "proc/self/mountinfo",
            "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n30 23 0:26 / /sys/fs/cgroup rw,nosuid shared:4 - cgroup2 cgroup2 rw\n",
        );
    }

    fn source(&self) -> LinuxMemorySource {
        LinuxMemorySource::with_root(&self.0, 4096)
    }

    fn root(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn parses_psi_and_meminfo_lines() {
    assert_eq!(
        psi_some_avg10("some avg10=0.42 avg60=0 avg300=0 total=1\n"),
        Some(0.42)
    );
    assert_eq!(psi_some_avg10("full avg10=9.00\n"), None);
    assert_eq!(
        meminfo_bytes("MemTotal: 10 kB\n", "MemTotal"),
        Some(10 * 1024)
    );
    assert_eq!(meminfo_bytes("MemTotalX: 10 kB\n", "MemTotal"), None);
}

#[test]
fn without_a_cgroup_uses_system_psi_meminfo_and_statm() {
    let fixture = Fixture::new("system");
    let sample = fixture.source().sample();
    assert_eq!(sample.psi_some_avg10, Some(12.5));
    assert_eq!(sample.total_bytes, Some(16 * GIB));
    assert_eq!(sample.available_bytes, Some(8 * GIB));
    assert_eq!(sample.host_rss_bytes, Some(250 * 4096));
    assert_eq!(
        classify(&sample, &MemoryThresholds::default()),
        PressureLevel::Low
    );
}

#[test]
fn a_finite_cgroup_limit_caps_total_and_available_and_its_pressure_wins() {
    let fixture = Fixture::new("cgroup");
    fixture.cgroup("/user.slice/app.scope");
    fixture.write("sys/fs/cgroup/user.slice/memory.max", "max\n");
    fixture.write(
        "sys/fs/cgroup/user.slice/app.scope/memory.max",
        &format!("{}\n", 2 * GIB),
    );
    fixture.write(
        "sys/fs/cgroup/user.slice/app.scope/memory.current",
        &format!("{}\n", 2 * GIB - 300 * MIB),
    );
    fixture.write(
        "sys/fs/cgroup/user.slice/app.scope/memory.pressure",
        "some avg10=35.00 avg60=1.00 avg300=0.00 total=5\n",
    );
    let sample = fixture.source().sample();
    assert_eq!(sample.total_bytes, Some(2 * GIB));
    assert_eq!(sample.available_bytes, Some(300 * MIB));
    assert_eq!(sample.psi_some_avg10, Some(35.0));
    assert_eq!(
        classify(&sample, &MemoryThresholds::default()),
        PressureLevel::Critical
    );
}

#[test]
fn an_ancestor_limit_applies_when_the_leaf_is_unlimited() {
    let fixture = Fixture::new("ancestor");
    fixture.cgroup("/kubepods/pod1/container");
    fixture.write(
        "sys/fs/cgroup/kubepods/pod1/memory.max",
        &format!("{}\n", 4 * GIB),
    );
    fixture.write(
        "sys/fs/cgroup/kubepods/pod1/memory.current",
        &format!("{}\n", GIB),
    );
    fixture.write("sys/fs/cgroup/kubepods/pod1/container/memory.max", "max\n");
    let sample = fixture.source().sample();
    assert_eq!(sample.total_bytes, Some(4 * GIB));
    assert_eq!(sample.available_bytes, Some(3 * GIB));
    assert_eq!(
        sample.psi_some_avg10,
        Some(12.5),
        "no cgroup pressure file: system PSI"
    );
}

#[test]
fn unlimited_cgroups_keep_system_memory_and_traversal_is_rejected() {
    let fixture = Fixture::new("unlimited");
    fixture.cgroup("/");
    fixture.write(
        "sys/fs/cgroup/memory.pressure",
        "some avg10=2.00 avg60=0 avg300=0 total=1\n",
    );
    let sample = fixture.source().sample();
    assert_eq!(sample.total_bytes, Some(16 * GIB));
    assert_eq!(sample.psi_some_avg10, Some(2.0));

    let escape = Fixture::new("escape");
    escape.cgroup("/../../outside");
    escape.write("outside/memory.max", "1024\n");
    let sample = escape.source().sample();
    assert_eq!(
        sample.total_bytes,
        Some(16 * GIB),
        "a `..` cgroup path is ignored"
    );
    assert!(escape.root().join("outside/memory.max").exists());
}

#[test]
fn missing_files_leave_signals_unavailable() {
    let root = std::env::temp_dir().join("bigbud-memory-definitely-missing-root");
    let sample = LinuxMemorySource::with_root(root, 4096).sample();
    assert_eq!(sample.psi_some_avg10, None);
    assert_eq!(sample.total_bytes, None);
    assert_eq!(sample.host_rss_bytes, None);
    assert_eq!(
        classify(&sample, &MemoryThresholds::default()),
        PressureLevel::Normal
    );
}
