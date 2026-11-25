use super::local::SshChild;
use bigbud_ssh_owner::opencode_v1::Startup;

const CONTROL_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Receipt {
    Rejected,
    Reaped,
    Exit(i32),
}

impl Receipt {
    pub(super) fn exit_code(self) -> Option<i32> {
        match self {
            Self::Exit(code) if code >= 0 => Some(code),
            _ => None,
        }
    }
}

pub(super) struct Control {
    prefix: Vec<u8>,
    line: Vec<u8>,
    truncated: bool,
    prepared: bool,
    launched: bool,
    terminal: Option<Receipt>,
}

impl Control {
    pub(super) fn new(nonce: &str) -> Self {
        Self {
            prefix: format!("bigbud-opencode-v1 {nonce} ").into_bytes(),
            line: Vec::with_capacity(CONTROL_LIMIT),
            truncated: false,
            prepared: false,
            launched: false,
            terminal: None,
        }
    }

    pub(super) fn drain(
        &mut self,
        ssh: &mut SshChild,
        startup: Option<&mut Startup>,
    ) -> Result<bool, ()> {
        let mut stdout = [0; 4096];
        let mut stderr = [0; 4096];
        let out = ssh.read(true, &mut stdout).map_err(|_| ())?;
        let err = ssh.read(false, &mut stderr).map_err(|_| ())?;
        let stdout = stdout.get(..out).ok_or(())?;
        let stderr = stderr.get(..err).ok_or(())?;
        self.ingest(stderr);
        if let Some(startup) = startup {
            if self.launched {
                startup.stdout(stdout).map_err(|_| ())?;
            } else {
                // Charge the shared cap but never accept pre-launch readiness.
                startup.stderr(stdout).map_err(|_| ())?;
            }
            startup.stderr(stderr).map_err(|_| ())?;
        }
        Ok(out != 0 || err != 0)
    }

    pub(super) fn ingest(&mut self, bytes: &[u8]) {
        if self.terminal.is_some() {
            return;
        }
        for &byte in bytes {
            if byte == b'\n' {
                if !self.truncated
                    && let Some(message) = self.line.strip_prefix(self.prefix.as_slice())
                {
                    if !self.launched {
                        self.prepared |= message == b"prepared";
                    } else {
                        self.terminal = match message {
                            b"rejected" => Some(Receipt::Rejected),
                            b"reaped" => Some(Receipt::Reaped),
                            message => exit_code(message).map(Receipt::Exit),
                        };
                        if self.terminal.is_some() {
                            return;
                        }
                    }
                }
                self.line.clear();
                self.truncated = false;
            } else if self.line.len() < CONTROL_LIMIT {
                self.line.push(byte);
            } else {
                self.truncated = true;
            }
        }
    }

    pub(super) fn prepared(&self) -> bool {
        self.prepared
    }
    pub(super) fn launched(&self) -> bool {
        self.launched
    }
    pub(super) fn note_launch(&mut self) {
        self.launched = true;
    }
    pub(super) fn terminal(&self) -> Option<Receipt> {
        self.terminal
    }
}

fn exit_code(message: &[u8]) -> Option<i32> {
    let text = std::str::from_utf8(message.strip_prefix(b"exit ")?).ok()?;
    let code: i32 = text.parse().ok()?;
    ((-64..=255).contains(&code) && text == code.to_string()).then_some(code)
}
