use super::{
    io::{read_line, write_line},
    pipe,
};
use crate::{
    inspect_local::control,
    local_control::protocol::{self, Endpoint},
};
use std::{
    io::{self, Write},
    os::windows::io::AsRawHandle,
    sync::atomic::AtomicBool,
    time::Duration,
};
pub(crate) fn run_client() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let frame = protocol::read_frame(&mut input)?
        .ok_or_else(|| io::Error::other("client request missing"))?;
    let fields: Vec<_> = frame.split('\t').collect();
    let ["CLIENT", "1", filename, backend, request] = fields.as_slice() else {
        return Err(io::Error::other("client protocol rejected"));
    };
    let filename =
        String::from_utf8(protocol::unhex(filename, 32768)?).map_err(io::Error::other)?;
    let bytes = control::read_private(&filename)?;
    let endpoint = Endpoint::parse(std::str::from_utf8(&bytes).map_err(io::Error::other)?)?;
    if endpoint.backend != *backend {
        return Err(io::Error::other("backend instance changed"));
    }
    let request = protocol::unhex(request, protocol::MAX_BYTES - 1)?;
    if request.contains(&b'\n') || request.is_empty() {
        return Err(io::Error::other("request frame rejected"));
    }
    let pipe = pipe::connect(&endpoint)?;
    if control::read_private(&filename)? != bytes {
        return Err(io::Error::other("endpoint changed during connect"));
    }
    let stopped = AtomicBool::new(false);
    write_line(pipe.as_raw_handle(), &request, &stopped)?;
    let response = read_line(pipe.as_raw_handle(), Duration::from_secs(35), &stopped)?;
    writeln!(io::stdout().lock(), "REPLY\t{}", protocol::hex(&response))
}
