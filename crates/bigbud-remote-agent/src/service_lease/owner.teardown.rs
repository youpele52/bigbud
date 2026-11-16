//! Original-scope teardown and terminal observation never grant activation.
use super::*;
impl LeaseOwner {
    /// Terminal-only evidence for an authenticated successor. Never bootstrap or a live grant.
    pub(crate) fn terminal_status(
        &mut self,
        binding: &Binding,
        capability: &[u8],
        controller: &Controller,
    ) -> Result<Option<Snapshot>> {
        if Controller::read(controller.pid)? != *controller {
            return Err(Error::Refused);
        }
        if let Some(snapshot) = self.retired.read(binding, capability)? {
            return Ok(Some(snapshot));
        }
        let Some(entry) = self.entry.as_ref() else {
            return Ok(None);
        };
        if entry.binding != *binding || !capability_matches(&entry.capability, capability) {
            return Err(Error::Refused);
        }
        if entry.controller != *controller && !entry.controller.dead()? {
            return Err(Error::Refused);
        }
        let snapshot = self.status()?;
        if snapshot.state != State::Exited {
            return Ok(None);
        }
        // Group-stop observation alone does not settle the owning monitor process.
        // Reuse original-handle teardown before minting terminal cleanup evidence.
        Ok(Some(self.stop_original(binding, capability, controller)?))
    }
    pub fn revoke(
        &mut self,
        binding: &Binding,
        capability: &[u8],
        controller: &Controller,
        generation: Generation,
    ) -> Result<Snapshot> {
        if self.authenticate(binding, capability, controller, true)? != generation {
            return Err(Error::Refused);
        }
        self.stop(generation)
    }
    /// Teardown of this exact retained original scope, never activation or PID adoption.
    pub fn stop_original(
        &mut self,
        binding: &Binding,
        capability: &[u8],
        controller: &Controller,
    ) -> Result<Snapshot> {
        if Controller::read(controller.pid)? != *controller {
            return Err(Error::Refused);
        }
        let Some(entry) = self.entry.as_mut() else {
            return self
                .retired
                .read(binding, capability)?
                .ok_or(Error::Uncertain);
        };
        if entry.binding != *binding || !capability_matches(&entry.capability, capability) {
            return Err(Error::Refused);
        }
        if entry.controller != *controller && !entry.controller.dead()? {
            return Err(Error::Refused);
        }
        if entry.monitor.stop().is_err() {
            entry.uncertain = true;
            return Err(Error::Uncertain);
        }
        if entry.controller != *controller {
            entry.previous_controller = Some(entry.controller.clone());
            entry.controller = controller.clone();
        }
        entry.uncertain = false;
        let result = Snapshot {
            binding: entry.binding.clone(),
            original_child_pid: entry.monitor.child_pid,
            state: State::Exited,
            original_controller: Some(entry.original_controller.clone()),
            current_controller: Some(entry.controller.clone()),
            previous_controller: entry.previous_controller.clone(),
        };
        self.retired.exited(result.clone(), entry.capability)?;
        self.entry.take();
        Ok(result)
    }
    pub(crate) fn stop(&mut self, generation: Generation) -> Result<Snapshot> {
        let entry = self.entry.as_mut().ok_or(Error::Refused)?;
        if entry.generation != generation {
            return Err(Error::Refused);
        }
        if entry.monitor.stop().is_err() {
            entry.uncertain = true;
            return Err(Error::Uncertain);
        }
        entry.uncertain = false;
        let result = Snapshot {
            binding: entry.binding.clone(),
            original_child_pid: entry.monitor.child_pid,
            state: State::Exited,
            original_controller: Some(entry.original_controller.clone()),
            current_controller: Some(entry.controller.clone()),
            previous_controller: entry.previous_controller.clone(),
        };
        self.retired.exited(result.clone(), entry.capability)?;
        self.entry.take();
        Ok(result)
    }
}
