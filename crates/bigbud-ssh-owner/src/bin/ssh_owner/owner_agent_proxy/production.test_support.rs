//! Shared test support for the production agent-proxy channel.
//!
//! The peer below speaks only the small OpenSSH mux v4 slice the owner uses:
//! one `NEW_SESSION`, three passed descriptors, one `SESSION_OPENED` reply and,
//! when the test chooses, one explicit `EXIT_MESSAGE`. No sshd or network is
//! involved.

use super::ProductionProxy;
use crate::Token;
use crate::transport::posix_master::open_agent_session;
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::net::UnixStream,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const SESSION_OPENED: u32 = 0x8000_0006;
const EXIT_MESSAGE: u32 = 0x8000_0004;
const REQUEST_ID: u32 = 2;
const LIMIT: Duration = Duration::from_secs(2);

pub(crate) struct RemoteChannels {
    pub(crate) stdin: File,
    pub(crate) stdout: File,
    pub(crate) stderr: File,
    pub(crate) control: UnixStream,
    exited: bool,
}

impl RemoteChannels {
    /// Publish the exact session exit the owner must confirm a close with.
    pub(crate) fn exit(&mut self, code: u32) {
        if self.exited {
            return;
        }
        let _ = self
            .control
            .write_all(&packet(EXIT_MESSAGE, REQUEST_ID, code));
        self.exited = true;
    }
}

pub(crate) struct ProxyPeer(JoinHandle<()>);

impl ProxyPeer {
    pub(crate) fn join(self) {
        self.0.join().expect("mux peer completed");
    }
}

/// Open one owner-side proxy over a fake mux peer. `peer` runs on the far side
/// with the three remote descriptors and may call `exit`.
pub(crate) fn proxy_pair(
    token: Token,
    pid: u32,
    command: &'static str,
    peer: impl FnOnce(RemoteChannels) + Send + 'static,
) -> (ProductionProxy, ProxyPeer) {
    let (owner, server) = UnixStream::pair().expect("private control pair");
    owner.set_nonblocking(true).expect("bounded owner control");
    server
        .set_read_timeout(Some(LIMIT))
        .expect("bounded peer control");
    server
        .set_write_timeout(Some(LIMIT))
        .expect("bounded peer control");
    let handle = thread::spawn(move || serve(server, command, peer));
    let io = open_agent_session(owner, command, Instant::now() + LIMIT).expect("owner session");
    let proxy = ProductionProxy::new(token, pid, io).expect("bounded proxy channel");
    (proxy, ProxyPeer(handle))
}

/// A proxy whose peer exits as soon as its stdin reaches EOF.
pub(crate) fn echo_proxy(
    token: Token,
    pid: u32,
    reply: &'static [u8],
    diagnostic: &'static [u8],
) -> (ProductionProxy, ProxyPeer) {
    proxy_pair(token, pid, "/owner/agent --proxy", move |mut channels| {
        let mut stdin = Vec::new();
        channels
            .stdin
            .read_to_end(&mut stdin)
            .expect("remote stdin");
        channels.stdout.write_all(reply).expect("remote stdout");
        channels
            .stderr
            .write_all(diagnostic)
            .expect("remote stderr");
        channels.exit(0);
    })
}

/// A proxy whose peer never emits a final exit, so close cannot be confirmed.
pub(crate) fn silent_proxy(token: Token, pid: u32) -> (ProductionProxy, ProxyPeer) {
    proxy_pair(token, pid, "/owner/agent --proxy", |mut channels| {
        let mut stdin = Vec::new();
        let _ = channels.stdin.read_to_end(&mut stdin);
        // Keep the control channel open until the owner gives up, so the
        // timeout path is exercised rather than an early EOF.
        thread::sleep(Duration::from_millis(300));
    })
}

fn serve(mut server: UnixStream, command: &str, peer: impl FnOnce(RemoteChannels)) {
    let mut header = [0u8; 44];
    server.read_exact(&mut header).expect("session header");
    let fields: Vec<u32> = header
        .chunks_exact(4)
        .map(|word| u32::from_be_bytes(word.try_into().expect("word")))
        .collect();
    let length = u32::try_from(command.len()).expect("bounded command");
    assert_eq!(
        fields,
        [
            40 + length,
            0x1000_0002,
            REQUEST_ID,
            0,
            0,
            0,
            0,
            0,
            u32::MAX,
            0,
            length
        ]
    );
    let mut sent = vec![0u8; command.len()];
    server.read_exact(&mut sent).expect("owner command");
    assert_eq!(sent, command.as_bytes());

    let stdin = File::from(receive_fd(&server));
    let stdout = File::from(receive_fd(&server));
    let stderr = File::from(receive_fd(&server));
    server
        .write_all(&packet(SESSION_OPENED, REQUEST_ID, 173))
        .expect("session opened");
    peer(RemoteChannels {
        stdin,
        stdout,
        stderr,
        control: server,
        exited: false,
    });
}

fn packet(kind: u32, first: u32, second: u32) -> Vec<u8> {
    [12, kind, first, second]
        .into_iter()
        .flat_map(u32::to_be_bytes)
        .collect()
}

fn receive_fd(stream: &UnixStream) -> OwnedFd {
    let mut data = [0u8];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr().cast(),
        iov_len: data.len(),
    };
    let mut control = [0usize; 4];
    // SAFETY: message fields are nullable pointers and integer lengths; the
    // recvmsg buffers are writable and CMSG_DATA is read only after checking for
    // one SCM_RIGHTS control message of the expected size.
    unsafe {
        let mut message: libc::msghdr = std::mem::zeroed();
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        assert_eq!(libc::recvmsg(stream.as_raw_fd(), &mut message, 0), 1);
        assert_eq!(message.msg_flags & libc::MSG_CTRUNC, 0);
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
        assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
        assert_eq!(
            (*header).cmsg_len as usize,
            libc::CMSG_LEN(std::mem::size_of::<RawFd>() as _) as usize
        );
        let received = libc::CMSG_DATA(header).cast::<RawFd>().read_unaligned();
        assert!(received >= 0);
        assert_eq!(libc::fcntl(received, libc::F_SETFD, libc::FD_CLOEXEC), 0);
        OwnedFd::from_raw_fd(received)
    }
}
