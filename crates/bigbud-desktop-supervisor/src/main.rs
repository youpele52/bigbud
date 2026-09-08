use std::io::{self, BufReader, BufWriter, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use bigbud_desktop_supervisor::{
    DEFAULT_MAX_FRAME_BYTES, Limits, OwnerSession, Supervisor, error_frame, read_frame,
    recovery_frame, v1, write_frame,
};

const ACK_TIMEOUT_ENV: &str = "BIGBUD_SUPERVISOR_ACK_TIMEOUT_MS";
const MAX_WATCHDOG_INTERVAL_MS: u64 = 100;

type SharedSupervisor = Arc<Mutex<Supervisor>>;
type SharedWriter = Arc<Mutex<BufWriter<io::Stdout>>>;

fn configured_limits() -> Result<Limits, Box<dyn std::error::Error>> {
    let mut limits = Limits::default();
    if let Some(raw) = std::env::var_os(ACK_TIMEOUT_ENV) {
        let value = raw.into_string().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{ACK_TIMEOUT_ENV} must be valid UTF-8"),
            )
        })?;
        let timeout = value.parse::<u64>().map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{ACK_TIMEOUT_ENV} must be an unsigned integer: {error}"),
            )
        })?;
        if timeout == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{ACK_TIMEOUT_ENV} must be greater than zero"),
            )
            .into());
        }
        limits.acknowledgement_timeout_ms = timeout;
    }
    Ok(limits)
}

fn write_frames(writer: &SharedWriter, frames: Vec<v1::Frame>) -> io::Result<()> {
    if frames.is_empty() {
        return Ok(());
    }
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("desktop supervisor stdout lock is poisoned"))?;
    for frame in frames {
        write_frame(&mut *writer, &frame, DEFAULT_MAX_FRAME_BYTES).map_err(io::Error::other)?;
    }
    writer.flush()
}

fn run_ack_watchdog(
    supervisor: SharedSupervisor,
    writer: SharedWriter,
    stop: Arc<AtomicBool>,
    started: Instant,
    interval: Duration,
) -> io::Result<()> {
    while !stop.load(Ordering::Acquire) {
        thread::sleep(interval);
        if stop.load(Ordering::Acquire) {
            break;
        }
        let now_ms = started.elapsed().as_millis() as u64;
        let actions = supervisor
            .lock()
            .map_err(|_| io::Error::other("desktop supervisor state lock is poisoned"))?
            .check_timeouts(now_ms);
        write_frames(&writer, actions.into_iter().map(recovery_frame).collect())?;
    }
    Ok(())
}

fn run_input_loop(
    supervisor: &SharedSupervisor,
    writer: &SharedWriter,
    limits: Limits,
    started: Instant,
) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut session = OwnerSession::new(limits, format!("supervisor-{}", std::process::id()));
    loop {
        let Some(frame) = read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES)? else {
            return Ok(());
        };
        let now_ms = started.elapsed().as_millis() as u64;
        let result = {
            let mut supervisor = supervisor
                .lock()
                .map_err(|_| io::Error::other("desktop supervisor state lock is poisoned"))?;
            session.handle_frame(&mut supervisor, frame, now_ms)
        };
        let (responses, close) = match result {
            Ok(result) => (result.responses, result.close),
            Err(error) => (vec![error_frame(&error)], false),
        };
        write_frames(writer, responses)?;
        if close {
            return Ok(());
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let limits = configured_limits()?;
    let started = Instant::now();
    let supervisor = Arc::new(Mutex::new(Supervisor::new(limits)));
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let stop = Arc::new(AtomicBool::new(false));
    let interval = Duration::from_millis(
        limits
            .acknowledgement_timeout_ms
            .min(MAX_WATCHDOG_INTERVAL_MS),
    );
    let watchdog = {
        let supervisor = Arc::clone(&supervisor);
        let writer = Arc::clone(&writer);
        let stop = Arc::clone(&stop);
        thread::spawn(move || run_ack_watchdog(supervisor, writer, stop, started, interval))
    };

    let input_result = run_input_loop(&supervisor, &writer, limits, started);
    stop.store(true, Ordering::Release);
    let watchdog_result = watchdog
        .join()
        .map_err(|_| io::Error::other("desktop supervisor ACK watchdog panicked"))?;
    input_result?;
    watchdog_result?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    run()
}
