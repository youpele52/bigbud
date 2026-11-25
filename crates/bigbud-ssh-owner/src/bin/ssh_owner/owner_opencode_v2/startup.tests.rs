use super::*;

fn startup(remote_port: u16) -> Startup {
    Startup::reserve(SocketAddrV4::new(Ipv4Addr::LOCALHOST, remote_port)).expect("reservation")
}

fn announce(ready: &mut Startup, port: u16) -> Result<(), ()> {
    ready.stdout(format!("{{\"url\":\"http://127.0.0.1:{port}\"}}\n").as_bytes())
}

fn never() -> bool {
    false
}

#[test]
fn readiness_requires_the_owner_selected_loopback_port() {
    let mut ready = startup(51_234);
    announce(&mut ready, 51_235).expect("charged");
    assert!(!ready.announced);
    announce(&mut ready, 51_234).expect("charged");
    assert!(ready.announced);
    // Once announced, later lines cannot change the endpoint.
    announce(&mut ready, 51_236).expect("charged");
    assert!(ready.announced);
    assert_eq!(ready.remote.port(), 51_234);
}

#[test]
fn readiness_rejects_every_other_shape_and_keeps_charging_output() {
    let mut ready = startup(51_234);
    for line in [
        "listening on http://127.0.0.1:51234\n",
        "{\"url\":\"http://localhost:51234\"}\n",
        "{\"url\":\"http://127.0.0.1:51234/\"}\n",
        "{\"url\":\"https://127.0.0.1:51234\"}\n",
        "{\"url\":51234}\n",
        "{\"url\":\"http://127.0.0.1:51234?x\"}\n",
    ] {
        ready.stdout(line.as_bytes()).expect("charged");
        assert!(!ready.announced, "{line}");
    }
    let oversized = vec![b'a'; MAX_LINE + 1];
    ready.stdout(&oversized).expect("charged");
    ready.stdout(b"\n").expect("charged");
    assert!(!ready.announced);
    assert!(ready.stdout(&vec![b'x'; OUTPUT_LIMIT]).is_err());
    assert_eq!(ready.settled, Some(Err(StartupError::OutputLimit)));
}

#[test]
fn the_credential_is_owner_generated_and_only_offered_after_the_launch_signal() {
    let ready = startup(51_234);
    let secret = ready.launch_secret().expect("v2 credential");
    assert_eq!(secret.len(), 64);
    assert!(
        secret
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    );
    assert!(ready.settled.is_none());
}

#[test]
fn an_unreachable_probe_stays_pending_and_cancellation_is_terminal() {
    let mut ready = startup(51_234);
    announce(&mut ready, 51_234).expect("charged");
    assert_eq!(ready.poll(&never).unwrap(), None);
    assert_eq!(ready.poll(&|| true).unwrap_err(), ReadyFailure::Cancelled);
}

#[test]
fn an_authenticated_v2_info_response_is_the_only_healthy_evidence() {
    let mut ready = startup(51_234);
    announce(&mut ready, 51_234).expect("charged");
    let listener = ready.listener().try_clone().expect("listener clone");
    let secret = ready.launch_secret().expect("credential").to_owned();
    let expected_secret = secret.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("probe connection");
        let expected = format!(
            "Basic {}",
            super::super::probe::auth_for_test(&expected_secret)
        );
        let mut request = [0_u8; 2048];
        let read = std::io::Read::read(&mut stream, &mut request).expect("request");
        let request = std::str::from_utf8(&request[..read]).expect("utf8 request");
        assert!(request.starts_with("GET /api/info HTTP/1.1\r\n"));
        assert!(request.contains(&expected), "{request}");
        let body = "{\"version\":\"2.1.4\",\"pid\":4242}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        std::io::Write::write_all(&mut stream, response.as_bytes()).expect("response");
    });
    let port = ready.poll(&never).expect("poll").expect("ready").port;
    assert!(port > 0);
    assert_ne!(port, 51_234, "the local listener is never the remote port");
    assert_eq!(ready.launch_secret(), Some(secret.as_str()));
    server.join().expect("probe server");
}

#[test]
fn probe_rejects_unauthenticated_or_non_v2_bodies() {
    for body in [
        "{\"version\":\"1.0.0\",\"pid\":1}",
        "{\"version\":\"2.1.4\"}",
        "{\"pid\":1}",
        "{\"version\":\"3.0.0\",\"pid\":1}",
        "not json",
    ] {
        assert!(
            !super::super::probe::v2_body_for_test(body.as_bytes()),
            "{body}"
        );
    }
    assert!(super::super::probe::v2_body_for_test(
        "{\"version\":\"2.0.0\",\"pid\":7}".as_bytes()
    ));
}
