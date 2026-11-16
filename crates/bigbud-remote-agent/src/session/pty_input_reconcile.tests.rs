use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn digest(bytes: &[u8]) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update(b"bigbud/pty-input/receipt-v1\0");
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
    hash.finalize().to_vec()
}

struct Fixture {
    session: AgentSession,
    job: Option<pty::PtyJob>,
    root: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            let _kill = job.handle.force_kill();
            let _events = pty::read_events(job.reader, &job.handle);
        }
        let _remove = std::fs::remove_dir(&self.root);
    }
}
impl Fixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "bigbud-input-receipt-{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ));
        std::fs::create_dir(&root)?;
        let mut session = AgentSession::new()?;
        session.handle(test_helpers::hello())?;
        session.handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "workspace".to_owned(),
                    workspace_handle: "w".to_owned(),
                    root: root.to_string_lossy().into_owned(),
                },
            )),
        })?;
        let (_, job) = session.prepare_pty_create(v1::PtyCreateRequest {
            request_id: "create".to_owned(),
            pty_id: "p".to_owned(),
            request_digest: vec![1; 32],
            workspace_handle: "w".to_owned(),
            shell: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), "sleep 10".to_owned()],
            cols: 80,
            rows: 24,
            ..Default::default()
        })?;
        Ok(Self { session, job, root })
    }
    fn request(&self, sequence: u64, bytes: &[u8]) -> v1::PtyInputReconcileRequest {
        v1::PtyInputReconcileRequest {
            request_id: "receipt".to_owned(),
            expected_epoch: self.session.agent_epoch.clone(),
            pty_id: "p".to_owned(),
            create_digest: vec![1; 32],
            sequence,
            payload_digest: digest(bytes),
            byte_length: bytes.len() as u64,
        }
    }
    fn send(
        &mut self,
        request: v1::PtyInputReconcileRequest,
    ) -> Result<v1::PtyInputReconcileResponse, Box<dyn std::error::Error>> {
        let frame = self.session.handle(v1::Frame {
            payload: Some(v1::frame::Payload::PtyInputReconcileRequest(request)),
        })?;
        match frame.payload {
            Some(v1::frame::Payload::PtyInputReconcileResponse(response)) => Ok(response),
            _ => Err("input receipt required".into()),
        }
    }
}

#[test]
fn wire_retirement_blocks_late_input_and_written_receipt_keeps_exact_identity() {
    let mut f = Fixture::new().unwrap();
    let handle = f.job.as_ref().unwrap().handle.clone();
    let pid = handle.pid;
    let request = f.request(1, b"never\n");
    let response = f.send(request.clone()).unwrap();
    assert!(response.accepted);
    assert_eq!(response.outcome, "not-admitted");
    assert_eq!(response.bytes_written, 0);
    assert_eq!(response.agent_epoch, request.expected_epoch);
    assert_eq!(response.payload_digest, request.payload_digest);
    assert!(handle.write_input(1, b"never\n").is_err());
    assert_eq!(f.send(request).unwrap().outcome, "not-admitted");
    assert!(handle.write_input(2, b"once\n").unwrap());
    let request = f.request(2, b"once\n");
    let response = f.send(request.clone()).unwrap();
    assert!(response.accepted && response.writer_usable);
    assert_eq!(response.outcome, "written");
    assert_eq!(response.bytes_written, 5);
    assert_eq!(response.sequence, 2);
    assert_eq!(response.create_digest, request.create_digest);
    assert_eq!(handle.pid, pid);
    assert_eq!(f.session.pty_sessions.len(), 1);
}

#[test]
fn wire_rejects_wrong_epoch_resource_payload_and_drain_admission() {
    let mut f = Fixture::new().unwrap();
    let valid = f.request(1, b"bytes");
    let mut requests = Vec::new();
    let mut wrong = valid.clone();
    wrong.expected_epoch = "old".to_owned();
    requests.push(wrong);
    let mut wrong = valid.clone();
    wrong.pty_id = "other".to_owned();
    requests.push(wrong);
    let mut wrong = valid.clone();
    wrong.create_digest = vec![2; 32];
    requests.push(wrong);
    let mut wrong = valid.clone();
    wrong.payload_digest = vec![2; 31];
    requests.push(wrong);
    let mut wrong = valid.clone();
    wrong.byte_length = 65537;
    requests.push(wrong);
    let mut wrong = valid.clone();
    wrong.request_id.clear();
    requests.push(wrong);
    for request in requests {
        assert!(!f.send(request).unwrap().accepted);
    }
    f.session.accepting_work = false;
    assert!(!f.send(valid.clone()).unwrap().accepted);
    f.session.accepting_work = true;
    assert!(f.send(valid.clone()).unwrap().accepted);
    let mut wrong = valid;
    wrong.payload_digest = digest(b"other");
    assert!(!f.send(wrong).unwrap().accepted);
}
