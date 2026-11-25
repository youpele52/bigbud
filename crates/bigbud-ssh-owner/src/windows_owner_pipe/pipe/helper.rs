//! Dedicated one-shot destination-password helper endpoint.

use super::{
    Deadline, ExpectedPipePeer, Operation, OwnerPipe, PeerEnd, PipeName, connect, frame::FramedIo,
    peer_pid,
};
use std::{
    io::{self, Read},
    os::windows::io::{AsRawHandle, OwnedHandle},
    path::Path,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::ERROR_PIPE_NOT_CONNECTED,
    System::Pipes::{DisconnectNamedPipe, PeekNamedPipe},
};

// Private helper channel, NOT an SSH owner protocol message. The only accepted
// operation is a destination-password claim. No user/prompt/path is parsed.
const DESTINATION_V1: [u8; 4] = *b"BB\x01\x01";
const REQUEST_LEN: usize = DESTINATION_V1.len() + 16;

pub(crate) mod entry;
mod reply;
#[cfg(test)]
pub(crate) use reply::exchange_reply;

pub(crate) struct Listener {
    name: PipeName,
    handle: Option<OwnedHandle>,
}

impl Listener {
    pub(crate) fn create() -> io::Result<Self> {
        let OwnerPipe { name, handle } = OwnerPipe::create()?;
        Ok(Self {
            name,
            handle: Some(handle),
        })
    }

    pub(crate) fn name(&self) -> &PipeName {
        &self.name
    }

    #[cfg(test)]
    pub(crate) fn observe_connection(&mut self, timeout: Duration) -> io::Result<()> {
        let deadline = Deadline::new(timeout)?;
        let connection = Connection {
            listener: &mut self.handle,
        };
        Operation::new(connection.handle()?, &deadline)?.accept()
    }

    pub(crate) fn receive(&mut self, image: &Path, timeout: Duration) -> io::Result<Request<'_>> {
        let deadline = Deadline::new(timeout)?;
        let connection = Connection {
            listener: &mut self.handle,
        };
        let mut operation = Operation::new(connection.handle()?, &deadline)?;
        operation.accept()?;
        let arrived_at = Instant::now();
        let helper = ExpectedPipePeer::observe_helper(|| connection.client_pid(), image)?;
        let mut reader = FramedIo(operation);
        let mut header = [0; 4];
        reader.read_exact(&mut header)?;
        if u32::from_be_bytes(header) as usize != REQUEST_LEN {
            return Err(rejected());
        }
        let mut opcode = [0; DESTINATION_V1.len()];
        reader.read_exact(&mut opcode)?;
        if opcode != DESTINATION_V1 {
            return Err(rejected());
        }
        let mut token = [0; 16];
        reader.read_exact(&mut token)?;
        deadline.remaining()?;
        Ok(Request {
            name: &self.name,
            connection,
            helper,
            token,
            arrived_at,
        })
    }
}

pub(crate) struct Request<'a> {
    pub(crate) name: &'a PipeName,
    connection: Connection<'a>,
    helper: ExpectedPipePeer,
    pub(crate) token: [u8; 16],
    pub(crate) arrived_at: Instant,
}

impl Request<'_> {
    #[cfg(test)]
    pub(crate) fn clone_helper_process(&self) -> io::Result<OwnedHandle> {
        self.helper.clone_process()
    }

    pub(crate) fn verify_parent(&self, ssh: &ExpectedPipePeer) -> io::Result<()> {
        ssh.verify_immediate_child(&self.helper)?;
        self.helper.verify(|| self.connection.client_pid())?;
        let mut available = 0;
        // SAFETY: live, exclusively held connection and valid writable count.
        let ok = unsafe {
            PeekNamedPipe(
                self.connection.handle()?.as_raw_handle(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut available,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if available != 0 {
            return Err(rejected());
        }
        Ok(())
    }
}

struct Connection<'a> {
    listener: &'a mut Option<OwnedHandle>,
}

impl Connection<'_> {
    fn handle(&self) -> io::Result<&OwnedHandle> {
        self.listener.as_ref().ok_or_else(rejected)
    }

    fn client_pid(&self) -> io::Result<u32> {
        peer_pid(self.handle()?, PeerEnd::Client)
    }
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        let Some(handle) = self.listener.as_ref() else {
            return;
        };
        // No outstanding overlapped I/O: each request was completed or drained.
        // SAFETY: handle exclusively owns this server instance.
        let disconnected = unsafe { DisconnectNamedPipe(handle.as_raw_handle()) } != 0;
        if !disconnected
            && io::Error::last_os_error().raw_os_error() != Some(ERROR_PIPE_NOT_CONNECTED as i32)
        {
            // Unexpected reset failure: retire the listener. Otherwise re-arm
            // only the same instance, with no namespace gap.
            *self.listener = None;
        }
    }
}

pub(crate) fn verify_child(peer: &ExpectedPipePeer) -> io::Result<u128> {
    peer.verified_birth_identity()
}

/// Verifies the owner before writing anything. Clean close is not an admission
/// or authentication receipt. No helper reads a password on this endpoint.
pub(crate) fn submit(
    name: &PipeName,
    expected_owner: &ExpectedPipePeer,
    token: [u8; 16],
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Deadline::new(timeout)?;
    let pipe = submit_on_verified_pipe(name, expected_owner, token, &deadline)?;
    let handle = pipe.handle.as_ref().ok_or_else(rejected)?;
    // Read at most one byte; no response bytes are defined on the helper wire.
    expect_close(&mut FramedIo(Operation::new(handle, &deadline)?))
}

fn submit_on_verified_pipe(
    name: &PipeName,
    expected_owner: &ExpectedPipePeer,
    token: [u8; 16],
    deadline: &Deadline,
) -> io::Result<super::VerifiedPipe> {
    expected_owner.verified_birth_identity()?;
    let mut pipe = connect(name, expected_owner, deadline.remaining()?)?;
    let mut body = [0; REQUEST_LEN];
    let (opcode, token_slot) = body.split_at_mut(DESTINATION_V1.len());
    opcode.copy_from_slice(&DESTINATION_V1);
    token_slot.copy_from_slice(&token);
    pipe.write_frame(&body, deadline.remaining()?)
        .map_err(io::Error::other)?;
    Ok(pipe)
}

fn expect_close(reader: &mut impl Read) -> io::Result<()> {
    match reader.read(&mut [0])? {
        0 => Ok(()),
        _ => Err(rejected()),
    }
}

fn rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "password helper request rejected",
    )
}
