use super::*;
use crate::owner::retirement::Kind;

impl Master {
    pub(super) fn spawn(
        &mut self,
        command: &mut Command,
        deadline: Instant,
    ) -> Result<(), ErrorCode> {
        if self.child.is_some() || self.recovery.is_some() || self.closing {
            return Err(UNAVAILABLE);
        }
        if Instant::now() >= deadline {
            return Err(LOST);
        }
        if let Some(retirement) = &self.retirement {
            let instance = retirement.begin(Kind::Master)?;
            self.master_record = Some(instance);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                if let (Some(retirement), Some(instance)) = (&self.retirement, &self.master_record)
                {
                    let _ = retirement.clear(instance);
                }
                self.master_record = None;
                return Err(UNAVAILABLE);
            }
        };
        if let (Some(retirement), Some(instance)) = (&self.retirement, &self.master_record)
            && let Err(error) = retirement.bind(instance, child.id())
        {
            // The child exists but cannot be identified. Reap it before
            // returning; only a confirmed wait clears the pre-spawn intent.
            if child.kill().is_ok() && child.wait().is_ok() {
                let _ = retirement.clear(instance);
                self.master_record = None;
            } else {
                // Retain the unverified child so checked reap can settle it;
                // the record stays until that reap is confirmed.
                self.child = Some(child);
                self.closing = true;
            }
            return Err(error);
        }
        // A master that cannot be tied to the owner's lifetime is not started.
        match super::owner_death::arm(child.id()) {
            Ok(watch) => self.death_watch = Some(watch),
            Err(_) => {
                if child.kill().is_ok() && child.wait().is_ok() {
                    if let (Some(retirement), Some(instance)) =
                        (&self.retirement, &self.master_record)
                    {
                        let _ = retirement.clear(instance);
                    }
                    self.master_record = None;
                } else {
                    self.child = Some(child);
                    self.closing = true;
                }
                return Err(UNAVAILABLE);
            }
        }
        self.child = Some(child);
        Ok(())
    }

    pub(super) fn live_pid(&mut self) -> Result<u32, ErrorCode> {
        let child = self.child.as_mut().ok_or(LOST)?;
        match child.try_wait().map_err(|_| UNAVAILABLE)? {
            None => Ok(child.id()),
            Some(_) => Err(LOST),
        }
    }

    pub(super) fn await_ready(&mut self, deadline: Instant) -> Result<(), ErrorCode> {
        self.await_ready_with(deadline, None)
    }

    pub(super) fn await_ready_with(
        &mut self,
        deadline: Instant,
        cancel: Cancel<'_>,
    ) -> Result<(), ErrorCode> {
        while Instant::now() < deadline {
            self.live_pid()?;
            if self.paths.observe()?.is_some() {
                return self
                    .verify_with(deadline.min(Instant::now() + CHECK_LIMIT), cancel)
                    .map(drop);
            }
            checkpoint(cancel)?;
            pause(deadline);
        }
        Err(LOST)
    }

    pub(super) fn remember_socket(
        &mut self,
        deadline: Instant,
    ) -> Result<(UnixStream, Stamp, u32), ErrorCode> {
        let pid = self.live_pid()?;
        let stamp = self.paths.observe()?.ok_or(LOST)?;
        if self.socket.is_some_and(|previous| previous != stamp) {
            return Err(UNAVAILABLE);
        }
        let stream = probe::connect_owned(&self.paths.socket, pid, deadline)?;
        if self.paths.observe()? != Some(stamp) {
            return Err(UNAVAILABLE);
        }
        // Cleanup authority requires kernel peer identity and the same inode.
        self.socket = Some(stamp);
        Ok((stream, stamp, pid))
    }

    pub(super) fn verify_with(
        &mut self,
        deadline: Instant,
        cancel: Cancel<'_>,
    ) -> Result<UnixStream, ErrorCode> {
        let (stream, stamp, pid) = self.remember_socket(deadline)?;
        probe::alive_with(&stream, pid, deadline, cancel)?;
        if self.paths.observe()? != Some(stamp) {
            return Err(UNAVAILABLE);
        }
        self.live_pid()?;
        Ok(stream)
    }

    pub(super) fn connect_with(
        &mut self,
        transport: &Transport,
        deadline: Instant,
        trust: TrustRead,
        cancel: Cancel<'_>,
    ) -> Result<UnixStream, ErrorCode> {
        checkpoint(cancel)?;
        self.binding.revalidate_with(transport, trust)?;
        let stream = self.verify_with(deadline.min(Instant::now() + CHECK_LIMIT), cancel)?;
        self.binding.revalidate_with(transport, trust)?;
        checkpoint(cancel)?;
        Ok(stream)
    }

    pub(super) fn connect(
        &mut self,
        transport: &Transport,
        deadline: Instant,
    ) -> Result<UnixStream, ErrorCode> {
        self.connect_with(transport, deadline, TrustRead::Default, None)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn verify(&mut self, deadline: Instant) -> Result<UnixStream, ErrorCode> {
        self.verify_with(deadline, None)
    }

    pub(super) fn attach_connector(
        &mut self,
        transport: &super::Transport,
        command: &mut std::process::Command,
    ) -> Result<(), ErrorCode> {
        if self.connector.is_some() || self.child.is_some() || self.closing {
            return Err(UNAVAILABLE);
        }
        let connector = transport.connector().ok_or(UNAVAILABLE)??;
        if let Some(retirement) = &self.retirement {
            let instance = retirement.begin(Kind::Connector)?;
            self.connector_record = Some(instance);
        }
        // Retain the helper first so any later failure reaps it with the lease.
        let mut child = match connector.spawn(transport.host(), transport.config.port) {
            Ok(child) => child,
            Err(_) => {
                if let (Some(retirement), Some(instance)) =
                    (&self.retirement, &self.connector_record)
                {
                    let _ = retirement.clear(instance);
                }
                self.connector_record = None;
                return Err(UNAVAILABLE);
            }
        };
        if let (Some(retirement), Some(instance)) = (&self.retirement, &self.connector_record)
            && let Err(error) = retirement.bind(instance, child.id())
        {
            if child.kill().is_ok() && child.wait().is_ok() {
                let _ = retirement.clear(instance);
                self.connector_record = None;
            } else {
                // Retain the unverified helper so checked reap can settle it.
                self.connector = Some(child);
                self.closing = true;
            }
            return Err(error);
        }
        let (Some(output), Some(input)) = (child.stdout.take(), child.stdin.take()) else {
            if child.kill().is_ok()
                && child.wait().is_ok()
                && let (Some(retirement), Some(instance)) =
                    (&self.retirement, &self.connector_record)
            {
                let _ = retirement.clear(instance);
                self.connector_record = None;
            }
            return Err(UNAVAILABLE);
        };
        self.connector = Some(child);
        command
            .stdin(std::process::Stdio::from(output))
            .stdout(std::process::Stdio::from(input));
        Ok(())
    }

    pub(super) fn reap(&mut self) -> Result<(), ErrorCode> {
        let reaped_master = self.reap_master()?;
        if reaped_master
            && let (Some(retirement), Some(instance)) = (&self.retirement, &self.master_record)
        {
            retirement.clear(instance)?;
            self.master_record = None;
        }
        if self.connector.is_none() {
            // A previous pass may have reaped the helper; clear its record now.
            if let (Some(retirement), Some(instance)) = (&self.retirement, &self.connector_record) {
                retirement.clear(instance)?;
                self.connector_record = None;
            }
            return Ok(());
        }
        let Some(child) = &mut self.connector else {
            return Ok(());
        };
        // Signal only the retained helper this lease spawned, never a PID by lookup.
        if child.try_wait().map_err(|_| UNAVAILABLE)?.is_none() {
            let _ = child.kill();
            let deadline = Instant::now() + REAP_LIMIT;
            while child.try_wait().map_err(|_| UNAVAILABLE)?.is_none() {
                if Instant::now() >= deadline {
                    return Err(UNAVAILABLE);
                }
                pause(deadline);
            }
        }
        self.connector = None;
        if let (Some(retirement), Some(instance)) = (&self.retirement, &self.connector_record) {
            retirement.clear(instance)?;
            self.connector_record = None;
        }
        Ok(())
    }

    fn reap_master(&mut self) -> Result<bool, ErrorCode> {
        let Some(child) = &mut self.child else {
            return Ok(false);
        };
        if child.try_wait().map_err(|_| UNAVAILABLE)?.is_none() {
            // Signal only the retained foreground child, never a PID from a
            // mux response and never send "exit" to a pathname or outside master.
            let signalled = child.kill().is_ok();
            let deadline = Instant::now() + REAP_LIMIT;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if signalled && Instant::now() < deadline => pause(deadline),
                    Err(error)
                        if error.kind() == std::io::ErrorKind::Interrupted
                            && Instant::now() < deadline => {}
                    _ => return Err(UNAVAILABLE),
                }
            }
        }
        self.child = None;
        if let Some(watch) = self.death_watch.take() {
            watch.disarm();
        }
        if let Some(recovery) = &mut self.recovery {
            recovery.record_reap();
        }
        Ok(true)
    }
}
