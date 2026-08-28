use super::*;

#[cfg(unix)]
pub fn run_proxy<R: Read + Send, W: Write>(
    mut input: R,
    mut output: W,
    socket_path: &Path,
) -> io::Result<()> {
    let mut socket = UnixStream::connect(socket_path)?;
    let mut socket_writer = socket.try_clone()?;
    std::thread::scope(|scope| {
        let input_thread = scope.spawn(move || {
            let result = io::copy(&mut input, &mut socket_writer);
            let _ = socket_writer.shutdown(std::net::Shutdown::Write);
            result
        });
        forward_socket_to_output(&mut socket, &mut output)?;
        input_thread
            .join()
            .map_err(|_| io::Error::other("proxy input thread panicked"))??;
        Ok(())
    })
}

#[cfg(unix)]
#[allow(clippy::indexing_slicing)]
fn forward_socket_to_output<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> io::Result<()> {
    let mut buffer = [0; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..read])?;
        writer.flush()?;
    }
}

#[cfg(not(unix))]
pub fn run_proxy<R: Read + Send, W: Write>(
    _input: R,
    _output: W,
    _socket_path: &Path,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the remote agent proxy requires Unix-domain sockets on this platform",
    ))
}
