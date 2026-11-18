//! Run on a Windows host: real pipe handles, SID/PID verification and overlapped settlement.
use super::{
    io::{read_line, write_line},
    pipe,
};
use std::{
    os::windows::io::AsRawHandle,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    thread,
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
fn name() -> String {
    format!(
        "\\\\.\\pipe\\bigbud-remote-agent-{:016x}{:016x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
#[test]
fn same_account_client_checks_server_generation_and_exchanges_one_frame() {
    let name = name();
    let listener = pipe::create(&name, true).expect("private first instance");
    let endpoint = pipe::self_endpoint(&name, &"a".repeat(64)).expect("self identity");
    let server = thread::spawn(move || {
        let stopped = AtomicBool::new(false);
        pipe::accept(&listener, &stopped).expect("accept");
        assert_eq!(
            read_line(listener.as_raw_handle(), Duration::from_secs(2), &stopped).expect("request"),
            b"request"
        );
        write_line(listener.as_raw_handle(), b"reply", &stopped).expect("reply");
    });
    let client = pipe::connect(&endpoint).expect("verified client");
    let stopped = AtomicBool::new(false);
    write_line(client.as_raw_handle(), b"request", &stopped).expect("request");
    assert_eq!(
        read_line(client.as_raw_handle(), Duration::from_secs(2), &stopped).expect("reply"),
        b"reply"
    );
    server.join().expect("server settled");
}
#[test]
fn cancellation_settles_connect_and_live_identity_is_never_reclaimable() {
    let name = name();
    let listener = pipe::create(&name, true).expect("private first instance");
    let endpoint = pipe::self_endpoint(&name, &"a".repeat(64)).expect("self identity");
    assert!(!pipe::prior_owner_dead(&endpoint).expect("self alive"));
    assert!(
        pipe::create(&name, true).is_err(),
        "no second first-instance owner"
    );
    let stopped = AtomicBool::new(true);
    assert_eq!(
        pipe::accept(&listener, &stopped)
            .expect_err("cancelled")
            .kind(),
        std::io::ErrorKind::TimedOut
    );
    drop(listener); // No pending OVERLAPPED is allowed to retain stack storage after cancellation.
    assert!(pipe::create(&name, true).is_ok());
}
