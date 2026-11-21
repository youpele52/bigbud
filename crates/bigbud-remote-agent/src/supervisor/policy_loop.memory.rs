//! Memory sampling for the policy loop (plan §8.6, §13 probes): a sample every 10 s, the
//! managed PTYs' tree RSS every 30 s, the spool budget every 30 s, and a `HostResourceReport`
//! to owners after each sample.

use crate::session::{HostLifecycle, PtyLifecycle};
use crate::terminal_policy::{MemorySampler, PressureLevel, classify};
use bigbud_protocol::v1;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const SAMPLE_EVERY: Duration = Duration::from_secs(10);
const TREE_EVERY: Duration = Duration::from_secs(30);

pub(super) struct Sampler {
    sampler: MemorySampler,
    next_sample: Instant,
    next_tree: Instant,
    terminal_rss: Option<u64>,
    spool_bytes: u64,
}

impl Sampler {
    pub fn new() -> Self {
        let now = Instant::now();
        Self {
            sampler: MemorySampler::new(),
            next_sample: now,
            next_tree: now,
            terminal_rss: None,
            spool_bytes: 0,
        }
    }

    pub fn tick(&mut self, host: &HostLifecycle, ptys: &[Arc<PtyLifecycle>]) {
        let now = Instant::now();
        if now < self.next_sample {
            return;
        }
        self.next_sample = now + SAMPLE_EVERY;
        let live = ptys.iter().filter(|pty| pty.is_live()).collect::<Vec<_>>();
        if now >= self.next_tree {
            self.next_tree = now + TREE_EVERY;
            let roots = live
                .iter()
                .filter(|pty| pty.managed())
                .filter_map(|pty| i32::try_from(pty.handle().pid).ok())
                .collect::<Vec<_>>();
            self.terminal_rss = (!roots.is_empty()).then(|| {
                host.probe
                    .tree_rss_many(&roots)
                    .into_iter()
                    .flatten()
                    .sum::<u64>()
            });
            if let Some(store) = host.spool() {
                match store.enforce_budget() {
                    Ok(report) => self.spool_bytes = report.used_bytes,
                    Err(error) => eprintln!("terminal spool budget check failed: {}", error.code()),
                }
            }
        }
        // §8.6 "host relief first": return freed allocator pages before counting host RSS.
        relieve_allocator();
        let sample = self.sampler.sample(self.terminal_rss);
        let policy = host.policy();
        let raw = classify(&sample, &policy.memory);
        let level = {
            let mut engine = host
                .engine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // With pressure closes off, the governor stays at Normal and never closes.
            engine.observe_memory(if host.pressure_enabled() {
                raw
            } else {
                PressureLevel::Normal
            })
        };
        let screen_bytes = ptys
            .iter()
            .filter_map(|pty| pty.screen().map(|screen| screen.estimated_bytes()))
            .sum::<usize>()
            .saturating_add(host.copy_bytes.load(Ordering::Acquire));
        let report = v1::HostResourceReport {
            sampled_at_ms: host.now_ms(),
            memory_level: match level.max(raw) {
                PressureLevel::Normal => "normal",
                PressureLevel::Low => "low",
                PressureLevel::Critical => "critical",
            }
            .to_owned(),
            memory_available_bytes: sample.available_bytes.unwrap_or(0),
            memory_total_bytes: sample.total_bytes.unwrap_or(0),
            host_rss_bytes: sample.host_rss_bytes.unwrap_or(0),
            terminal_rss_bytes: self.terminal_rss.unwrap_or(0),
            screen_model_bytes: screen_bytes as u64,
            spool_bytes: self.spool_bytes,
            live_ptys: u32::try_from(live.len()).unwrap_or(u32::MAX),
            managed_live_ptys: u32::try_from(live.iter().filter(|pty| pty.managed()).count())
                .unwrap_or(u32::MAX),
            max_live_ptys: policy.max_live_ptys,
        };
        host.broadcast(&v1::Frame {
            payload: Some(v1::frame::Payload::HostResourceReport(Box::new(report))),
        });
    }
}

/// Returns free allocator pages to the OS (bursts of output copies leave them resident).
#[cfg(target_os = "macos")]
fn relieve_allocator() {
    unsafe extern "C" {
        /// `<malloc/malloc.h>`: a null zone relieves every zone; goal 0 releases all it can.
        fn malloc_zone_pressure_relief(zone: *mut libc::c_void, goal: libc::size_t)
        -> libc::size_t;
    }
    // SAFETY: documented libmalloc API; with a null zone it walks the process's own zones and
    // only releases pages that hold no live allocation.
    let _released = unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn relieve_allocator() {
    // SAFETY: glibc's malloc_trim only returns free heap memory; it takes the allocator's locks.
    let _trimmed = unsafe { libc::malloc_trim(0) };
}

/// musl and other allocators return large free blocks eagerly; nothing to do.
#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn relieve_allocator() {}
