use bigbud_desktop_supervisor::organization::protocol::{
    scheduling::v1::{NativeFrame, native_frame},
    v1::{Frame, frame},
};
use prost::Message;
use std::{
    error::Error,
    io::{self, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
type Spawned = (
    OwnedChild,
    ChildStdin,
    mpsc::Receiver<io::Result<NativeFrame>>,
);
fn spawn() -> Result<Spawned, Box<dyn Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-desktop-supervisor"))
        .args(["--thread-organization", "scheduling-owner", "1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let mut stdout = child.stdout.take().ok_or("missing stdout")?;
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        loop {
            let result = (|| {
                let mut prefix = [0; 4];
                stdout.read_exact(&mut prefix)?;
                let size = u32::from_be_bytes(prefix) as usize;
                if size == 0 || size > 1_048_576 {
                    return Err(io::Error::other("invalid native length"));
                }
                let mut bytes = vec![0; size];
                stdout.read_exact(&mut bytes)?;
                NativeFrame::decode(bytes.as_slice()).map_err(io::Error::other)
            })();
            let stop = result.is_err();
            if tx.send(result).is_err() || stop {
                return;
            }
        }
    });
    Ok((OwnedChild(child), stdin, rx))
}
fn send(stdin: &mut ChildStdin, bytes: &[u8]) -> io::Result<()> {
    stdin.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stdin.write_all(bytes)?;
    stdin.flush()
}
fn golden() -> Result<Vec<Vec<u8>>, Box<dyn Error>> {
    include_str!("../../../protocol/thread-organization/scheduling-fixture.hex")
        .lines()
        .map(|line| {
            line.as_bytes()
                .chunks_exact(2)
                .map(|pair| Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?))
                .collect()
        })
        .collect()
}
fn stopped(child: &mut Child, success: bool) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        if let Some(status) = child.try_wait()? {
            if status.success() != success {
                return Err("unexpected organisation exit status".into());
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("organisation process did not exit within3s".into())
}
#[test]
fn real_process_activates_ts_snapshot_and_emits_a_fenced_native_movement()
-> Result<(), Box<dyn Error>> {
    let (mut child, mut stdin, output) = spawn()?;
    for bytes in golden()? {
        let decoded = Frame::decode(bytes.as_slice())?;
        if decoded.encode_to_vec() != bytes {
            return Err("noncanonical shared scheduling fixture".into());
        }
        send(&mut stdin, &bytes)?;
    }
    let ready = output.recv_timeout(Duration::from_secs(3))??;
    if ready.backend_nonce != "scheduling-owner"
        || ready.generation != 1
        || !matches!(ready.payload, Some(native_frame::Payload::Ready(_)))
    {
        return Err("invalid ready identity/payload".into());
    }
    let proposal = output.recv_timeout(Duration::from_secs(3))??;
    let Some(native_frame::Payload::Proposal(proposal)) = proposal.payload else {
        return Err("missing native proposal".into());
    };
    if proposal.thread_id != "thread-a"
        || proposal.destination != 2
        || !proposal.operation_id.starts_with("inyosira:")
    {
        return Err("invalid native movement".into());
    }
    drop(stdin);
    stopped(&mut child.0, true)
}
#[test]
fn real_process_rejects_oversized_truncated_and_stale_owner_frames() -> Result<(), Box<dyn Error>> {
    for kind in 0..3 {
        let (mut child, mut stdin, _output) = spawn()?;
        match kind {
            0 => stdin.write_all(&1_048_577u32.to_be_bytes())?,
            1 => {
                stdin.write_all(&100u32.to_be_bytes())?;
                stdin.write_all(&[1, 2])?;
            }
            _ => {
                let bytes = Frame {
                    backend_nonce: "other".into(),
                    generation: 1,
                    payload: Some(frame::Payload::Heartbeat(Default::default())),
                }
                .encode_to_vec();
                send(&mut stdin, &bytes)?;
            }
        }
        drop(stdin);
        stopped(&mut child.0, false)?;
    }
    Ok(())
}
