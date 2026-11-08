//! Dedicated server-owned process mode. Reader/writer workers have bounded queues. On EOF,
//! protocol error, owner timeout or blocked-output capacity, main returns and the dedicated
//! process exits: no unbounded join of an OS pipe blocked in a worker is attempted.
use super::session::Session;
use super::timing::ClockSample;
use prost::Message;
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_FRAME: usize = 1_048_576;
fn fail(message: &'static str) -> io::Error {
    io::Error::other(message)
}
fn receive(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0u8; 4];
    let first = reader.read(&mut prefix[..1])?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut prefix[1..])?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(fail("invalid organisation length prefix"));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}
fn input(sender: SyncSender<io::Result<Option<Vec<u8>>>>) {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let frame = receive(&mut reader);
        let done = !matches!(frame, Ok(Some(_)));
        if sender.send(frame).is_err() || done {
            return;
        }
    }
}
fn output(receiver: Receiver<Vec<u8>>, failures: SyncSender<()>) {
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    for payload in receiver {
        let result = writer
            .write_all(&(payload.len() as u32).to_be_bytes())
            .and_then(|_| writer.write_all(&payload))
            .and_then(|_| writer.flush());
        if result.is_err() {
            let _ = failures.try_send(());
            return;
        }
    }
}
fn clock(started: Instant) -> io::Result<ClockSample> {
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| fail("wall clock precedes epoch"))?
        .as_millis();
    let wall_ms = i64::try_from(wall).map_err(|_| fail("wall clock overflow"))?;
    let monotonic_ms = u64::try_from(started.elapsed().as_millis())
        .map_err(|_| fail("monotonic clock overflow"))?;
    Ok(ClockSample {
        wall_ms,
        monotonic_ms,
    })
}
fn send(
    sender: &SyncSender<Vec<u8>>,
    frames: Vec<super::protocol::scheduling::v1::NativeFrame>,
    maximum: usize,
) -> io::Result<()> {
    for frame in frames {
        let bytes = frame.encode_to_vec();
        if bytes.len() > maximum {
            return Err(fail("native organisation response exceeds frame bound"));
        }
        sender.try_send(bytes).map_err(|error| match error {
            TrySendError::Full(_) => fail("organisation output stalled"),
            TrySendError::Disconnected(_) => fail("organisation output closed"),
        })?;
    }
    Ok(())
}
pub fn run(nonce: String, generation: u64) -> io::Result<()> {
    if nonce.is_empty()
        || nonce.len() > 256
        || generation == 0
        || generation > 9_007_199_254_740_991
    {
        return Err(fail("invalid organisation owner identity"));
    }
    let started = Instant::now();
    let mut session = Session::new(nonce, generation, clock(started)?);
    let (input_tx, input_rx) = mpsc::sync_channel(8);
    let (output_tx, output_rx) = mpsc::sync_channel(8);
    let (failure_tx, failure_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("organization-input".into())
        .spawn(move || input(input_tx))?;
    std::thread::Builder::new()
        .name("organization-output".into())
        .spawn(move || output(output_rx, failure_tx))?;
    loop {
        if failure_rx.try_recv().is_ok() {
            return Err(fail("organisation stdout failed"));
        }
        match input_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(Some(bytes))) => send(
                &output_tx,
                session.receive(&bytes, clock(started)?).map_err(fail)?,
                session.maximum(),
            )?,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(fail("organisation input closed"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        send(
            &output_tx,
            session.tick(clock(started)?).map_err(fail)?,
            session.maximum(),
        )?;
    }
}
