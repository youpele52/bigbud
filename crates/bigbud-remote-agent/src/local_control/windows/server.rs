use super::{
    io::{read_line, write_line},
    pipe,
};
use crate::{
    inspect_local::control,
    local_control::protocol::{self, MAX_CLIENTS},
};
use std::{
    collections::HashMap,
    io::{self, Write},
    os::windows::io::{AsRawHandle, OwnedHandle},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

type Pending = Arc<Mutex<HashMap<u64, Option<SyncSender<Vec<u8>>>>>>;
type Output = Arc<Mutex<io::Stdout>>;
fn emit(output: &Output, line: &str) -> io::Result<()> {
    let mut output = output.lock().map_err(|_| io::Error::other("output lock"))?;
    writeln!(output, "{line}")?;
    output.flush()
}
fn responses(pending: Pending, stopped: Arc<AtomicBool>, next: Arc<AtomicU64>) -> io::Result<()> {
    let mut input = io::stdin().lock();
    while let Some(frame) = protocol::read_frame(&mut input)? {
        let fields: Vec<_> = frame.split('\t').collect();
        let ["S", id, bytes] = fields.as_slice() else {
            return Err(io::Error::other("reply protocol rejected"));
        };
        let id = id.parse::<u64>().map_err(io::Error::other)?;
        if id == 0 || id >= next.load(Ordering::Acquire) {
            return Err(io::Error::other("unissued reply identity"));
        }
        let bytes = protocol::unhex(bytes, protocol::MAX_BYTES - 1)?;
        let mut pending = pending
            .lock()
            .map_err(|_| io::Error::other("pending lock"))?;
        if let Some(sender) = pending.get_mut(&id) {
            let sender = sender
                .take()
                .ok_or_else(|| io::Error::other("duplicate reply identity"))?;
            // A closed transport does not cancel a previously accepted backend operation.
            let _closed_transport = sender.try_send(bytes);
        }
        // Issued but retired IDs are stale replies: discard without redispatch or allocation.
        if stopped.load(Ordering::Acquire) {
            break;
        }
    }
    Ok(())
}
fn worker(
    pipe: OwnedHandle,
    id: u64,
    receiver: mpsc::Receiver<Vec<u8>>,
    pending: Pending,
    output: Output,
    stopped: Arc<AtomicBool>,
) {
    let result = (|| -> io::Result<()> {
        let request = read_line(pipe.as_raw_handle(), Duration::from_secs(5), &stopped)?;
        emit(&output, &format!("R\t{id}\t{}", protocol::hex(&request)))?;
        let began = Instant::now();
        loop {
            if stopped.load(Ordering::Acquire) || began.elapsed() >= Duration::from_secs(30) {
                return Ok(());
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(reply) => return write_line(pipe.as_raw_handle(), &reply, &stopped),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    })();
    if emit(&output, &format!("C\t{id}")).is_err() {
        stopped.store(true, Ordering::Release);
    }
    if let Ok(mut pending) = pending.lock() {
        pending.remove(&id);
    } else {
        stopped.store(true, Ordering::Release);
    }
    // Invalid/disconnected clients close only their transport; never terminate accepted work.
    let _client_transport_result = result;
}
pub(crate) fn run_server() -> io::Result<()> {
    let frame = {
        let mut input = io::stdin().lock();
        protocol::read_frame(&mut input)?
            .ok_or_else(|| io::Error::other("server handshake missing"))?
    };
    let fields: Vec<_> = frame.split('\t').collect();
    let ["SERVER", "1", name, filename, backend, lock_path, lock_hash] = fields.as_slice() else {
        return Err(io::Error::other("server handshake rejected"));
    };
    let name = String::from_utf8(protocol::unhex(name, 256)?).map_err(io::Error::other)?;
    let filename =
        String::from_utf8(protocol::unhex(filename, 32768)?).map_err(io::Error::other)?;
    let lock_path =
        String::from_utf8(protocol::unhex(lock_path, 32768)?).map_err(io::Error::other)?;
    let _backend_lease = control::BackendLease::open(&lock_path, lock_hash)?;
    let mut listener = pipe::create(&name, true)?;
    let endpoint = pipe::self_endpoint(&name, backend)?;
    let publication =
        control::Publication::create(&filename, endpoint.encode().as_bytes(), pipe::nonce(&name)?)?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let stopped = Arc::new(AtomicBool::new(false));
    let next = Arc::new(AtomicU64::new(1));
    emit(&output, "READY\t1")?;
    let input_worker = {
        let pending = pending.clone();
        let stopped = stopped.clone();
        let next = next.clone();
        thread::spawn(move || {
            let result = responses(pending, stopped.clone(), next);
            stopped.store(true, Ordering::Release);
            result
        })
    };
    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
    let serving = (|| -> io::Result<()> {
        while !stopped.load(Ordering::Acquire) {
            for index in (0..workers.len()).rev() {
                if workers.get(index).is_some_and(|w| w.is_finished()) {
                    workers
                        .remove(index)
                        .join()
                        .map_err(|_| io::Error::other("pipe worker failed"))?;
                }
            }
            if workers.len() >= MAX_CLIENTS {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            match pipe::accept(&listener, &stopped) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    let replacement = pipe::create(&name, false)?;
                    listener = replacement;
                    continue;
                }
                Err(error) => return Err(error),
            }
            // Keep a name-owning instance alive before handing the accepted instance to a worker.
            let replacement = pipe::create(&name, false)?;
            let accepted = std::mem::replace(&mut listener, replacement);
            let mut entries = pending
                .lock()
                .map_err(|_| io::Error::other("pending lock"))?;
            if entries.len() >= MAX_CLIENTS {
                drop(accepted);
                continue;
            }
            let id = next
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
                .map_err(|_| io::Error::other("pipe request id exhausted"))?;
            let (sender, receiver) = mpsc::sync_channel(1);
            entries.insert(id, Some(sender));
            drop(entries);
            let pending = pending.clone();
            let output = output.clone();
            let stopped = stopped.clone();
            workers.push(thread::spawn(move || {
                worker(accepted, id, receiver, pending, output, stopped)
            }));
        }
        Ok(())
    })();
    stopped.store(true, Ordering::Release);
    drop(listener);
    for worker in workers {
        worker
            .join()
            .map_err(|_| io::Error::other("pipe worker failed"))?;
    }
    // The parent closes stdin during normal shutdown; on protocol failure it terminates this owned helper.
    if input_worker.is_finished() {
        input_worker
            .join()
            .map_err(|_| io::Error::other("input worker failed"))??;
    }
    let removal = publication.remove();
    serving?;
    removal
}
