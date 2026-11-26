//! Private reply wire: stage bytes, commit after re-verification, and
//! acknowledge only a complete helper handoff. This is not an SSH receipt.

use super::*;
use crate::windows_password_gate::PasswordBytes;
use std::io::Write;

const REPLY: [u8; 4] = *b"BB\x01\x02";
const READY: [u8; 4] = *b"BB\x01\x03";
const COMMIT: [u8; 4] = *b"BB\x01\x04";
const DELIVERED: [u8; 4] = *b"BB\x01\x05";
const MAX_PASSWORD: usize = 1024;

pub(crate) fn valid_password(bytes: &[u8]) -> bool {
    (1..=MAX_PASSWORD).contains(&bytes.len())
        && !bytes.iter().any(|byte| matches!(*byte, 0 | b'\r' | b'\n'))
}

impl Request<'_> {
    pub(crate) fn deliver(
        self,
        ssh: &ExpectedPipePeer,
        until: Instant,
        bytes: &[u8],
    ) -> io::Result<()> {
        let deadline = Deadline::until(until)?;
        if !valid_password(bytes) {
            return Err(rejected());
        }
        self.verify_parent(ssh)?;
        let mut stream = FramedIo(Operation::new(self.connection.handle()?, &deadline)?);
        write_tag(&mut stream, REPLY, &self.token)?;
        stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
        stream.write_all(bytes)?;
        read_tag(&mut stream, READY, &self.token)?;
        self.verify_parent(ssh)?;
        deadline.remaining()?;
        write_tag(&mut stream, COMMIT, &self.token)?;
        // DisconnectNamedPipe discards unread bytes. Require the complete
        // output receipt before closing, not just a successful pipe write.
        read_tag(&mut stream, DELIVERED, &self.token)?;
        deadline.remaining()?;
        Ok(())
    }
}

pub(crate) fn exchange_reply(
    name: &PipeName,
    owner: &ExpectedPipePeer,
    token: [u8; 16],
    timeout: Duration,
    deliver_line: impl FnOnce(&[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let deadline = Deadline::new(timeout)?;
    let pipe = submit_on_verified_pipe(name, owner, token, &deadline)?;
    let handle = pipe.handle.as_ref().ok_or_else(rejected)?;
    let mut stream = FramedIo(Operation::new(handle, &deadline)?);
    let line = read_reply(&mut stream, &token)?;
    write_tag(&mut stream, READY, &token)?;
    read_tag(&mut stream, COMMIT, &token)?;
    owner.verify(|| peer_pid(handle, PeerEnd::Server))?;
    deadline.remaining()?;
    deliver_line(line.as_slice())?;
    write_tag(&mut stream, DELIVERED, &token)?;
    deadline.remaining()?;
    Ok(())
}

fn write_tag(writer: &mut impl Write, tag: [u8; 4], token: &[u8; 16]) -> io::Result<()> {
    writer.write_all(&tag)?;
    writer.write_all(token)
}

fn read_tag(reader: &mut impl Read, tag: [u8; 4], token: &[u8; 16]) -> io::Result<()> {
    let mut actual_tag = [0; 4];
    let mut actual_token = [0; 16];
    reader.read_exact(&mut actual_tag)?;
    reader.read_exact(&mut actual_token)?;
    if actual_tag != tag || actual_token != *token {
        return Err(rejected());
    }
    Ok(())
}

fn read_reply(reader: &mut impl Read, token: &[u8; 16]) -> io::Result<PasswordBytes> {
    read_tag(reader, REPLY, token)?;
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if !(1..=MAX_PASSWORD).contains(&length) {
        return Err(rejected());
    }
    // Read into an already zeroizing allocation, including on a partial
    // read. Leave room for LF so stdout needs no second plaintext buffer.
    let mut line = PasswordBytes::from_boxed_slice(vec![0; length + 1].into_boxed_slice());
    let (lf, body) = line.as_mut_slice().split_last_mut().ok_or_else(rejected)?;
    reader.read_exact(body)?;
    if !valid_password(body) {
        return Err(rejected());
    }
    *lf = b'\n';
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mismatched_reply_oversized_truncated_and_non_line_bodies() {
        let token = [7; 16];
        let header = [&REPLY[..], &token, &(2u32).to_be_bytes()].concat();
        let message = [&header[..], b"OK"].concat();
        let mut line = read_reply(&mut message.as_slice(), &token).expect("one valid line");
        assert_eq!(line.as_slice(), b"OK\n");
        line.observe_wipe(|bytes| assert_eq!(bytes, &[0; 3]));
        assert!(read_reply(&mut message.as_slice(), &[8; 16]).is_err());
        for body in [b"O".as_slice(), b"\rX", b"\nX", b"\0X"] {
            assert!(read_reply(&mut [&header[..], body].concat().as_slice(), &token).is_err());
        }
        let oversized = [
            &REPLY[..],
            &token,
            &((MAX_PASSWORD + 1) as u32).to_be_bytes(),
        ]
        .concat();
        assert!(read_reply(&mut oversized.as_slice(), &token).is_err());
        assert!(
            read_tag(
                &mut [&READY[..], &token].concat().as_slice(),
                COMMIT,
                &token
            )
            .is_err()
        );
    }
}
