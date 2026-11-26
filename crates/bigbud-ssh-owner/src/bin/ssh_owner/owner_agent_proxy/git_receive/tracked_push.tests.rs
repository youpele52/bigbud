use super::*;
use std::{
    io::Read,
    os::fd::OwnedFd,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

const OLD: &str = "1111111111111111111111111111111111111111";
const NEW: &str = "2222222222222222222222222222222222222222";
const BRANCH: &str = "refs/heads/main";
const PACK: &[u8] = b"PACK disposable connector test";

fn request() -> TrackedPushRequest {
    TrackedPushRequest {
        binding: TrackedPushBinding {
            repository: RepositoryIdentity {
                worktree: "/tmp/bigbud-picker-linux-Test/client".into(),
                git_dir: "/tmp/bigbud-picker-linux-Test/client/.git".into(),
                common_dir: "/tmp/bigbud-picker-linux-Test/client/.git".into(),
            },
            remote_name: "origin".into(),
            source_ref: BRANCH.into(),
            destination_ref: BRANCH.into(),
            source_oid: NEW.into(),
            destination: TrackedDestination {
                effective_url: "ssh://picker@127.0.0.1:22222/receive.git".into(),
                execution_target_id: "ssh:host=127.0.0.1&user=picker&port=22222".into(),
                target_generation: "a".repeat(64),
                host: "127.0.0.1".into(),
                user: "picker".into(),
                port: 22222,
                repository_path: "/receive.git".into(),
                expected_old_oid: OLD.into(),
            },
        },
        timeout_ms: 1_000,
    }
}

fn packet(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

fn advertisement(old: &str) -> Vec<u8> {
    [
        packet(&format!(
            "{old} {BRANCH}\0report-status ofs-delta agent=fixture\n"
        )),
        b"0000".to_vec(),
    ]
    .concat()
}

fn prefix(old: &str, new: &str) -> Vec<u8> {
    [
        packet(&format!("{old} {new} {BRANCH}\0 report-status\n")),
        b"0000".to_vec(),
    ]
    .concat()
}

fn report(status: &str) -> Vec<u8> {
    [packet("unpack ok\n"), packet(status), b"0000".to_vec()].concat()
}

fn pipes() -> (File, File) {
    let (read, write) = io::pipe().unwrap();
    (
        File::from(OwnedFd::from(read)),
        File::from(OwnedFd::from(write)),
    )
}

struct Lease {
    current: bool,
    cancelled: Arc<AtomicBool>,
    retired: Arc<Mutex<Option<DestinationReceipt>>>,
}

impl PushLease for Lease {
    fn is_current(&mut self) -> bool {
        self.current
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    fn retire(self, _deadline: Instant, receipt: DestinationReceipt) {
        assert_eq!(*self.retired.lock().unwrap(), None);
        *self.retired.lock().unwrap() = Some(receipt);
    }
}

struct Peers {
    to_connector_from_git: File,
    from_connector_to_git: File,
    from_connector_to_receiver: File,
    to_connector_from_receiver: File,
}

fn graph(current: bool) -> (ActivePush<Lease>, Peers) {
    let (git_input, to_connector_from_git) = pipes();
    let (from_connector_to_git, git_output) = pipes();
    let (from_connector_to_receiver, receive_input) = pipes();
    let (receive_output, to_connector_from_receiver) = pipes();
    let lease = Lease {
        current,
        cancelled: Arc::new(AtomicBool::new(false)),
        retired: Arc::new(Mutex::new(None)),
    };
    (
        ActivePush {
            git_input,
            git_output,
            receive_output,
            receive_input,
            lease,
        },
        Peers {
            to_connector_from_git,
            from_connector_to_git,
            from_connector_to_receiver,
            to_connector_from_receiver,
        },
    )
}

fn assert_denied_without_launch(connector: &mut Connector, request: &TrackedPushRequest) {
    let mut launched = false;
    assert_eq!(
        connector.run::<Lease>(request, |_, _| {
            launched = true;
            Err(io::ErrorKind::Other.into())
        }),
        TrackedPushResult::DeniedBeforeDispatch
    );
    assert!(!launched);
}

#[test]
fn denies_nonidentical_approval_without_launch_and_never_replays() {
    let mut request = request();
    let approved = request.binding.clone();
    let mut connector = Connector::new(approved.clone()).unwrap();
    request.binding.destination.target_generation = "b".repeat(64);
    assert_denied_without_launch(&mut connector, &request);
    request.binding = approved.clone();
    request.binding.destination.effective_url.push('/');
    assert_denied_without_launch(&mut connector, &request);
    assert!(Connector::new(request.binding.clone()).is_err());
    request.binding = approved;
    request.timeout_ms = 30_001;
    assert_denied_without_launch(&mut connector, &request);
    request.timeout_ms = 1_000;
    assert_eq!(
        connector.run::<Lease>(&request, |_, _| Err(io::ErrorKind::NotFound.into())),
        TrackedPushResult::DeniedBeforeDispatch
    );
    assert_denied_without_launch(&mut connector, &request);
}

#[test]
fn forwards_exact_prefix_and_pack_and_relays_only_verified_receipts() {
    for (wire, receipt) in [
        (report("ok refs/heads/main\n"), DestinationReceipt::Accepted),
        (
            report("ng refs/heads/main stale update\n"),
            DestinationReceipt::Rejected,
        ),
        (
            report("ok refs/heads/other\n"),
            DestinationReceipt::Unconfirmed,
        ),
    ] {
        let request = request();
        let mut connector = Connector::new(request.binding.clone()).unwrap();
        let (active, mut peers) = graph(true);
        let retired = Arc::clone(&active.lease.retired);
        peers
            .to_connector_from_receiver
            .write_all(&advertisement(OLD))
            .unwrap();
        let expected = [prefix(OLD, NEW), PACK.to_vec()].concat();
        peers.to_connector_from_git.write_all(&expected).unwrap();
        let reply = wire.clone();
        let receive = thread::spawn(move || {
            let mut bytes = vec![0; expected.len()];
            peers
                .from_connector_to_receiver
                .read_exact(&mut bytes)
                .unwrap();
            assert_eq!(bytes, expected);
            peers.to_connector_from_receiver.write_all(&reply).unwrap();
        });
        assert_eq!(
            connector.run(&request, |_, _| Ok(active)),
            TrackedPushResult::Finished(receipt)
        );
        receive.join().unwrap();
        assert_eq!(*retired.lock().unwrap(), Some(receipt));
        let mut delivered = Vec::new();
        peers
            .from_connector_to_git
            .read_to_end(&mut delivered)
            .unwrap();
        let narrowed = [
            packet(&format!("{OLD} {BRANCH}\0report-status ofs-delta")),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(
            delivered.strip_prefix(narrowed.as_slice()),
            Some(if receipt == DestinationReceipt::Unconfirmed {
                &[]
            } else {
                wire.as_slice()
            })
        );
        assert_denied_without_launch(&mut connector, &request);
    }
}

#[test]
fn stale_lease_or_mismatched_oid_never_writes_to_receiver() {
    for (current, old, new) in [(false, OLD, NEW), (true, NEW, NEW), (true, OLD, OLD)] {
        let request = request();
        let mut connector = Connector::new(request.binding.clone()).unwrap();
        let (active, mut peers) = graph(current);
        peers
            .to_connector_from_receiver
            .write_all(&advertisement(OLD))
            .unwrap();
        peers
            .to_connector_from_git
            .write_all(&prefix(old, new))
            .unwrap();
        assert_eq!(
            connector.run(&request, |_, _| Ok(active)),
            TrackedPushResult::Finished(DestinationReceipt::Unconfirmed)
        );
        let mut remote = Vec::new();
        peers
            .from_connector_to_receiver
            .read_to_end(&mut remote)
            .unwrap();
        assert!(remote.is_empty());
    }
}

#[test]
fn unchanged_requires_a_current_exact_advertisement_and_writes_nothing() {
    for (current, old, receipt) in [
        (true, OLD, DestinationReceipt::Unchanged),
        (true, NEW, DestinationReceipt::Unconfirmed),
        (false, OLD, DestinationReceipt::Unconfirmed),
    ] {
        let mut request = request();
        request.binding.source_oid = OLD.into();
        let mut connector = Connector::new(request.binding.clone()).unwrap();
        let (active, mut peers) = graph(current);
        peers
            .to_connector_from_receiver
            .write_all(&advertisement(old))
            .unwrap();
        // Even an active client cannot get a byte through the no-op path.
        peers
            .to_connector_from_git
            .write_all(&prefix(OLD, NEW))
            .unwrap();
        assert_eq!(
            connector.run(&request, |_, _| Ok(active)),
            TrackedPushResult::Finished(receipt)
        );
        let mut remote = Vec::new();
        peers
            .from_connector_to_receiver
            .read_to_end(&mut remote)
            .unwrap();
        assert!(remote.is_empty());
    }
}

#[test]
fn a_stalled_receiver_does_not_block_pack_writes_or_retirement() {
    let mut request = request();
    request.timeout_ms = 100;
    let mut connector = Connector::new(request.binding.clone()).unwrap();
    let (active, mut peers) = graph(true);
    let retired = Arc::clone(&active.lease.retired);
    peers
        .to_connector_from_receiver
        .write_all(&advertisement(OLD))
        .unwrap();
    let command = prefix(OLD, NEW);
    peers.to_connector_from_git.write_all(&command).unwrap();
    let git = thread::spawn(move || {
        // Leave both receiver streams live while refusing to drain its input.
        // The client writer may get BrokenPipe once the bounded graph closes.
        let _written = peers.to_connector_from_git.write_all(&vec![1; 64 * 1024]);
    });
    assert_eq!(
        connector.run(&request, |_, _| Ok(active)),
        TrackedPushResult::Finished(DestinationReceipt::Unconfirmed)
    );
    git.join().unwrap();
    assert_eq!(
        *retired.lock().unwrap(),
        Some(DestinationReceipt::Unconfirmed)
    );
    let mut remote = Vec::new();
    peers
        .from_connector_to_receiver
        .read_to_end(&mut remote)
        .unwrap();
    assert!(remote.starts_with(&command));
}

#[test]
fn deadline_and_cancellation_abort_a_live_stalled_advertisement() {
    for cancelled in [true, false] {
        let mut request = request();
        request.timeout_ms = 25;
        let mut connector = Connector::new(request.binding.clone()).unwrap();
        let (active, mut peers) = graph(true);
        let retired = Arc::clone(&active.lease.retired);
        active.lease.cancelled.store(cancelled, Ordering::Relaxed);
        peers.to_connector_from_receiver.write_all(b"00").unwrap();
        assert_eq!(
            connector.run(&request, |_, _| Ok(active)),
            TrackedPushResult::Finished(DestinationReceipt::Unconfirmed)
        );
        assert_eq!(
            *retired.lock().unwrap(),
            Some(DestinationReceipt::Unconfirmed)
        );
    }
}
