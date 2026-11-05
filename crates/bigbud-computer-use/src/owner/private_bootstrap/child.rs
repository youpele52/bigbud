use super::{
    exchange::{ChildCredential, child_read},
    route::Route,
};
use std::{io, os::unix::net::UnixStream, time::Instant};

/// Inherited-once private route + credential. Neither is exposed to public/model
/// callers. Construction requires the dedicated startup slot's production permit.
/// No Clone/Debug/token/path accessor; connect consumes even a failed attempt.
/// ```compile_fail
/// use bigbud_computer_use::owner::private_bootstrap::ChildBootstrap;
/// fn retry(child: ChildBootstrap) {
///     let _ = child.connect();
///     let _ = child.connect();
/// }
/// ```
pub struct ChildBootstrap {
    credential: ChildCredential,
    route: Route,
    deadline: Instant,
}
impl ChildBootstrap {
    pub(super) fn read(courier: UnixStream, deadline: Instant) -> io::Result<Self> {
        crate::owner::unix_peer::ensure_private_fd(&courier)?;
        let route = Route::read(&courier, deadline)?;
        let credential = child_read(courier, deadline)?;
        Ok(Self {
            credential,
            route,
            deadline,
        })
    }

    /// Kernel peer identity is checked BEFORE any credential bytes are sent.
    /// The returned stream is not an authenticated parent lifeline capability;
    /// reciprocal role/capability negotiation remains separate integration work.
    pub fn connect(self) -> io::Result<UnixStream> {
        let stream = self.route.connect(self.deadline)?;
        let stream = self.credential.send(stream)?;
        self.route.verify_server(&stream, self.deadline)?;
        Ok(stream)
    }
}
