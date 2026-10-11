use super::*;
use std::{
    net::{TcpListener, TcpStream, UdpSocket},
    os::windows::io::AsRawSocket,
};

#[test]
fn native_sockets_never_reach_foreign_retention() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let client = TcpStream::connect(listener.local_addr()?)?;
    let (peer, _) = listener.accept()?;
    let udp = UdpSocket::bind("127.0.0.1:0")?;
    let disk = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .open(std::env::current_exe()?)?;
    // SAFETY: query-only pseudo handle, never closed or duplicated.
    let entries = snapshot(unsafe { GetCurrentProcess() })?;
    let file_kind = entries
        .iter()
        .find(|entry| entry.handle == disk.as_raw_handle())
        .ok_or_else(|| io::Error::other("fixture disk handle absent"))?
        .type_index;
    let sockets = [
        listener.as_raw_socket(),
        client.as_raw_socket(),
        peer.as_raw_socket(),
        udp.as_raw_socket(),
    ];
    for socket in sockets {
        let entry = entries
            .iter()
            .find(|entry| entry.handle as usize == socket as usize)
            .ok_or_else(|| io::Error::other("fixture socket handle absent"))?;
        // Native evidence: kernel File metadata alone cannot distinguish these sockets from disk.
        assert_eq!(entry.type_index, file_kind);
    }
    let mut attempted = Vec::new();
    let result =
        super::super::windows::inspect_recording_retention(std::process::id(), |_, source, _| {
            attempted.push(source as usize);
            // An old implementation is observed without actually duplicating any foreign/socket handle.
            // The only clone is this test-owned, live regular disk file.
            Ok(disk.try_clone()?.into())
        });
    assert!(
        attempted
            .iter()
            .all(|handle| !sockets.iter().any(|socket| *socket as usize == *handle))
    );
    assert!(
        attempted.is_empty(),
        "unresolved File candidates reached retention"
    );
    assert_eq!(
        result.expect_err("unresolved inventory must reject").kind(),
        io::ErrorKind::Unsupported
    );
    Ok(())
}

#[test]
fn native_unresolved_inventory_rejects_without_partial_success() -> io::Result<()> {
    let disk = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .open(std::env::current_exe()?)?;
    let mut calls = 0;
    let result =
        super::super::windows::inspect_recording_retention(std::process::id(), |_, _, _| {
            calls += 1;
            Ok(disk.try_clone()?.into())
        });
    assert_eq!(calls, 0);
    assert_eq!(
        result.expect_err("disk provenance unavailable").kind(),
        io::ErrorKind::Unsupported
    );
    Ok(())
}
