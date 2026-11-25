use std::{
    fs::File,
    io::{self, Read, Write},
    os::fd::AsRawFd,
    process::{ChildStdin, ChildStdout},
    time::{Duration, Instant},
};

const PACK_CAP: usize = 64 * 1024;
const IO_DEADLINE: Duration = Duration::from_secs(10);

/// Send a capped pack while draining the reply. An outer hard timeout on
/// the fixed SSH process also bounds a blocked write to its stdin.
pub(super) fn exchange(
    mut git: File,
    mut response: ChildStdout,
    request: ChildStdin,
    report_cap: usize,
) -> io::Result<Vec<u8>> {
    let mut request = Some(request);
    let expires = Instant::now() + IO_DEADLINE;
    let mut report = Vec::new();
    let mut sent = 0;
    let mut data = [0; 4096];
    loop {
        let mut fds = [
            pollfd(response.as_raw_fd()),
            pollfd(if request.is_some() {
                git.as_raw_fd()
            } else {
                -1
            }),
        ];
        let remaining = expires.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let ms = i32::try_from(remaining.as_millis().max(1)).map_err(io::Error::other)?;
        // SAFETY: fds is an initialized two-element array, exclusively lent
        // to poll for this call; the open pipe handles outlive the call.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, ms) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let [remote, local] = fds;
        if remote.revents != 0 {
            let count = response.read(&mut data)?;
            if count == 0 {
                if sent == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                return Ok(report);
            }
            if report.len() + count > report_cap {
                return Err(io::ErrorKind::InvalidData.into());
            }
            report.extend(chunk(&data, count)?);
        }
        if local.revents != 0
            && let Some(sink) = &mut request
        {
            let count = git.read(&mut data)?;
            if count == 0 {
                request = None;
            } else {
                sent += count;
                if sent > PACK_CAP {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                sink.write_all(chunk(&data, count)?)?;
            }
        }
    }
}

fn pollfd(fd: i32) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }
}

fn chunk(data: &[u8], count: usize) -> io::Result<&[u8]> {
    data.get(..count).ok_or(io::ErrorKind::InvalidData.into())
}
