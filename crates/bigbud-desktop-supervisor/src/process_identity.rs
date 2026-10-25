use prost::Message;
use std::io::{self, Write};

mod wire {
    include!(concat!(env!("OUT_DIR"), "/bigbud.process_identity.v1.rs"));
}

/// Emits one bounded protobuf response; never terminates or modifies the inspected process.
pub fn run(pid: &str) -> Result<(), Box<dyn std::error::Error>> {
    let pid: u32 = pid.parse()?;
    let identity = bigbud_system::process_identity::inspect(pid)
        .ok_or_else(|| io::Error::other("process identity unavailable"))?;
    let executable = identity
        .executable
        .to_str()
        .ok_or_else(|| io::Error::other("non-UTF8 executable"))?
        .to_owned();
    let message = wire::Identity {
        version: 1,
        pid,
        executable,
        arguments: identity.arguments,
        same_user: identity.same_user,
    };
    let bytes = message.encode_to_vec();
    if bytes.len() > 16384 {
        return Err(io::Error::other("identity exceeds limit").into());
    }
    io::stdout().lock().write_all(&bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use prost::Message;

    #[test]
    fn process_identity_golden() {
        let message = super::wire::Identity {
            version: 1,
            pid: 42,
            executable: "/x".into(),
            arguments: vec!["/x".into()],
            same_user: true,
        };
        assert_eq!(
            message.encode_to_vec(),
            [8, 1, 16, 42, 26, 2, 47, 120, 34, 2, 47, 120, 40, 1]
        );
    }
}
