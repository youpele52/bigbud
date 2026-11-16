//! One bounded original lease. Detach and native cancellation are separate.
use super::identity::{capability_hash, capability_matches};
use super::process::{Launch, Monitor, SecretEnvironment};
use super::{Binding, Controller, Error, Result};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
fn next_generation() -> Result<Generation> {
    NEXT_GENERATION
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            n.checked_add(1).filter(|n| *n <= 9_007_199_254_740_991)
        })
        .map(Generation)
        .map_err(|_| Error::Uncertain)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Generation(u64);
impl Generation {
    pub(crate) fn value(self) -> u64 {
        self.0
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Spawned,
    Exited,
    Uncertain,
    Cancelled,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub binding: Binding,
    /// Diagnostic evidence only, never a control/adoption token.
    pub original_child_pid: u32,
    pub state: State,
    pub original_controller: Option<Controller>,
    pub current_controller: Option<Controller>,
    pub previous_controller: Option<Controller>,
}
pub struct Grant {
    pub snapshot: Snapshot,
    generation: Generation,
}
impl Grant {
    pub fn generation(&self) -> Generation {
        self.generation
    }
}
struct Entry {
    binding: Binding,
    capability: [u8; 32],
    payload: [u8; 32],
    bootstrap: SecretEnvironment,
    controller: Controller,
    original_controller: Controller,
    previous_controller: Option<Controller>,
    generation: Generation,
    attached: bool,
    monitor: Monitor,
    uncertain: bool,
}
pub struct LeaseOwner {
    monitor_executable: PathBuf,
    native_epoch: String,
    entry: Option<Entry>,
    // Never evict a terminal nonce to permit accidental accepted-work replay.
    retired: super::retention::Retained,
}
impl LeaseOwner {
    pub fn new(native_epoch: String) -> Result<Self> {
        Self::with_monitor(PathBuf::from("/proc/self/exe"), native_epoch)
    }
    /// Trusted embedding/test factory, never a renderer-supplied executable.
    pub fn with_monitor(monitor_executable: PathBuf, native_epoch: String) -> Result<Self> {
        if !cfg!(target_os = "linux") {
            return Err(Error::Unsupported);
        }
        if native_epoch.is_empty() || native_epoch.len() > 128 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            monitor_executable,
            native_epoch,
            entry: None,
            retired: super::retention::Retained::default(),
        })
    }
    pub fn start(
        &mut self,
        binding: Binding,
        controller: Controller,
        capability: &[u8],
        launch: Launch,
    ) -> Result<Grant> {
        binding.validate()?;
        if binding.native_epoch != self.native_epoch
            || Controller::read(controller.pid)? != controller
        {
            return Err(Error::Refused);
        }
        if let Some(assets) = &launch.assets {
            assets.validate(&binding, &launch.args)?;
        }
        let hash = capability_hash(capability)?;
        let payload = launch.fingerprint(&binding.executable_sha256)?;
        if binding.guard_sha256
            != launch
                .guard
                .as_ref()
                .map(super::Guard::digest)
                .unwrap_or([0; 32])
        {
            return Err(Error::Refused);
        }
        if let Some(entry) = &self.entry {
            if entry.binding == binding
                && entry.payload == payload
                && capability_matches(&entry.capability, capability)
                && entry.controller == controller
                && entry.attached
                && !entry.uncertain
            {
                // An idempotent accepted start never performs another spawn.
                return self.grant();
            }
            return Err(Error::Occupied);
        }
        if self.retired.contains(&binding.nonce) || self.retired.full() {
            return Err(Error::Occupied);
        }
        let generation = next_generation()?;
        let bootstrap = launch.environment.clone();
        let (monitor, readiness) =
            Monitor::start(&self.monitor_executable, launch, binding.executable_sha256)?;
        self.entry = Some(Entry {
            binding,
            capability: hash,
            payload,
            bootstrap,
            original_controller: controller.clone(),
            previous_controller: None,
            controller,
            generation,
            attached: true,
            monitor,
            uncertain: readiness.is_err(),
        });
        if readiness.is_err() {
            return Err(Error::Uncertain);
        }
        self.grant()
    }
    fn grant(&mut self) -> Result<Grant> {
        let snapshot = self.status()?;
        if snapshot.state == State::Uncertain {
            return Err(Error::Uncertain);
        }
        let generation = self.entry.as_ref().ok_or(Error::Refused)?.generation;
        Ok(Grant {
            snapshot,
            generation,
        })
    }
    pub fn status(&mut self) -> Result<Snapshot> {
        let entry = self.entry.as_mut().ok_or(Error::Refused)?;
        if !entry.uncertain && entry.monitor.observe().is_err() {
            entry.uncertain = true;
        }
        Ok(Snapshot {
            binding: entry.binding.clone(),
            original_child_pid: entry.monitor.child_pid,
            original_controller: Some(entry.original_controller.clone()),
            current_controller: Some(entry.controller.clone()),
            previous_controller: entry.previous_controller.clone(),
            state: if entry.uncertain {
                State::Uncertain
            } else if entry.monitor.stopped {
                State::Exited
            } else {
                State::Spawned
            },
        })
    }
    pub fn detach(&mut self, generation: Generation) -> Result<()> {
        let entry = self.entry.as_mut().ok_or(Error::Refused)?;
        if entry.generation != generation {
            return Err(Error::Refused);
        }
        entry.attached = false;
        Ok(())
    }
    pub fn resume(
        &mut self,
        binding: &Binding,
        capability: &[u8],
        controller: Controller,
    ) -> Result<Grant> {
        let entry = self.entry.as_mut().ok_or(Error::Refused)?;
        if entry.uncertain
            || entry.binding != *binding
            || !capability_matches(&entry.capability, capability)
            || Controller::read(controller.pid)? != controller
        {
            return Err(Error::Refused);
        }
        match entry.monitor.refresh_validity() {
            Ok(true) => (),
            Ok(false) => return Err(Error::Refused),
            Err(_) => {
                entry.uncertain = true;
                return Err(Error::Uncertain);
            }
        }
        if Controller::read(controller.pid)? != controller {
            return Err(Error::Refused);
        }
        if entry.controller == controller {
            if !entry.attached {
                return Err(Error::Refused);
            }
            return self.grant();
        }
        if !entry.controller.dead()? {
            return Err(Error::Refused);
        }
        let generation = next_generation()?;
        entry.previous_controller = Some(entry.controller.clone());
        entry.controller = controller;
        entry.generation = generation;
        entry.attached = true;
        self.grant()
    }
    /// Private owner-transport handoff only; status/journal never contains this data.
    pub fn with_bootstrap<A>(
        &self,
        generation: Generation,
        consume: impl FnOnce(&SecretEnvironment) -> A,
    ) -> Result<A> {
        let entry = self.entry.as_ref().ok_or(Error::Refused)?;
        if entry.generation != generation
            || !entry.attached
            || entry.uncertain
            || entry.monitor.stopped
        {
            return Err(Error::Refused);
        }
        Ok(consume(&entry.bootstrap))
    }
    pub(crate) fn retained_status(
        &self,
        binding: &Binding,
        capability: &[u8],
    ) -> Result<Option<Snapshot>> {
        self.retired.read(binding, capability)
    }
    pub(crate) fn cancel_start(&mut self, binding: Binding, capability: &[u8]) -> Result<Snapshot> {
        binding.validate()?;
        if binding.native_epoch != self.native_epoch {
            return Err(Error::Refused);
        }
        if self.entry.is_some() {
            return Err(Error::Occupied);
        }
        self.retired.cancel(binding, capability)
    }
    pub(crate) fn present(&self) -> bool {
        self.entry.is_some()
    }
    pub(crate) fn active(&self) -> bool {
        self.entry
            .as_ref()
            .is_some_and(|entry| entry.uncertain || !entry.monitor.stopped)
    }
    pub(crate) fn authenticate(
        &self,
        binding: &Binding,
        capability: &[u8],
        controller: &Controller,
        detached_stop: bool,
    ) -> Result<Generation> {
        let entry = self.entry.as_ref().ok_or(Error::Refused)?;
        if entry.binding != *binding
            || !capability_matches(&entry.capability, capability)
            || entry.controller != *controller
            || entry.uncertain
            || (!entry.attached && !detached_stop)
            || Controller::read(controller.pid)? != *controller
        {
            return Err(Error::Refused);
        }
        Ok(entry.generation)
    }
    pub(crate) fn shutdown(&mut self) -> Result<()> {
        if let Some(entry) = self.entry.as_mut() {
            if entry.monitor.stop().is_err() {
                entry.uncertain = true;
                return Err(Error::Uncertain);
            }
            entry.uncertain = false;
        }
        Ok(())
    }
}

#[path = "owner.teardown.rs"]
mod teardown;
