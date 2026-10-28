use super::framework::{self, Console};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Security,
    Account,
    NoGui,
    Malformed,
    NotInteractive,
    Changed,
    Invalidated,
}

/// Framework-derived sample with no caller constructor or field mutation.
/// It deliberately conveys no unlocked/continuous/ready assertion.
/// ```compile_fail
/// use bigbud_computer_use::guard::InteractiveSnapshot;
/// let sample = InteractiveSnapshot { uid: 501, session: 42, console: 0 };
/// ```
#[derive(PartialEq, Eq)]
pub struct InteractiveSnapshot {
    uid: u32,
    session: u32,
    console: u32,
}

// Private backend seam. Only Native exists outside cfg(test); renderer/provider
// data cannot be injected into the production sampler or recovery binding.
pub(super) trait Backend {
    fn account(&mut self) -> Result<(u32, u32), SnapshotError>;
    fn security(&mut self) -> Result<(u32, u32), SnapshotError>;
    fn console(&mut self) -> Result<Console, SnapshotError>;
}
struct Native;
impl Backend for Native {
    fn account(&mut self) -> Result<(u32, u32), SnapshotError> {
        // SAFETY: getuid/geteuid have no pointer inputs or ownership effects.
        Ok(unsafe { (libc::getuid(), libc::geteuid()) })
    }
    fn security(&mut self) -> Result<(u32, u32), SnapshotError> {
        framework::security()
    }
    fn console(&mut self) -> Result<Console, SnapshotError> {
        framework::console()
    }
}
pub(super) fn read() -> Result<InteractiveSnapshot, SnapshotError> {
    sample(&mut Native)
}
fn valid_security((session, bits): (u32, u32)) -> Result<u32, SnapshotError> {
    // AuthSession.h: root=1, graphic=0x10, tty=0x20, remote=0x1000.
    // Reserved special IDs are never valid outputs. Unknown flags fail closed.
    if session == 0 || session >= u32::MAX - 1 || bits & !0x1031 != 0 {
        return Err(SnapshotError::Malformed);
    }
    if bits & 0x10 == 0 || bits & 0x1001 != 0 {
        return Err(SnapshotError::NotInteractive);
    }
    Ok(session)
}
pub(super) fn sample(backend: &mut impl Backend) -> Result<InteractiveSnapshot, SnapshotError> {
    let account = backend.account()?;
    if account.0 == 0 || account.0 != account.1 {
        return Err(SnapshotError::Account);
    }
    let security = backend.security()?;
    let session = valid_security(security)?;
    let console = backend.console()?;
    if console.uid != account.0 || !console.on_console || !console.login_done {
        return Err(SnapshotError::NotInteractive);
    }
    // Bracket the dictionary with account + Security checks. This catches
    // observed changes, NOT all transitions or cross-framework atomicity/ABA.
    if backend.security()? != security || backend.account()? != account {
        return Err(SnapshotError::Changed);
    }
    Ok(InteractiveSnapshot {
        uid: account.0,
        session,
        console: console.set,
    })
}
#[cfg(test)]
pub(super) fn fixture_sample() -> InteractiveSnapshot {
    InteractiveSnapshot {
        uid: 501,
        session: 42,
        console: 0,
    }
}
