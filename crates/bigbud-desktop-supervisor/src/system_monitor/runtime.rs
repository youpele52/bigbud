use super::{
    frame::{read_frame, write_frame},
    state::State,
};
use crate::monitor_v1 as v1;
use std::{
    io::{self, BufReader, BufWriter, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

fn send(writer: &Mutex<BufWriter<io::Stdout>>, frames: Vec<v1::Frame>) -> io::Result<()> {
    if frames.is_empty() {
        return Ok(());
    }
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("monitor writer poisoned"))?;
    for frame in frames {
        write_frame(&mut *writer, &frame)?;
    }
    writer.flush()
}

pub fn run() -> io::Result<()> {
    let state = Arc::new(Mutex::new(State::new()));
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let stop = Arc::new(AtomicBool::new(false));
    let timer = {
        let state = Arc::clone(&state);
        let writer = Arc::clone(&writer);
        let stop = Arc::clone(&stop);
        thread::spawn(move || -> io::Result<()> {
            while !stop.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(100));
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let frames = state
                    .lock()
                    .map_err(|_| io::Error::other("monitor state poisoned"))?
                    .tick(Instant::now());
                send(&writer, frames)?;
            }
            Ok(())
        })
    };
    let mut reader = BufReader::new(io::stdin().lock());
    let result = loop {
        match read_frame(&mut reader) {
            Ok(Some(frame)) => {
                let handled = state
                    .lock()
                    .map_err(|_| io::Error::other("monitor state poisoned"))
                    .map(|mut state| state.handle(frame, Instant::now()));
                let (frames, close) = match handled {
                    Ok(value) => value,
                    Err(error) => break Err(error),
                };
                if let Err(error) = send(&writer, frames) {
                    break Err(error);
                }
                if close {
                    break Ok(());
                }
            }
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    stop.store(true, Ordering::Release);
    let joined = timer
        .join()
        .map_err(|_| io::Error::other("monitor timer panicked"))?;
    result?;
    joined
}
