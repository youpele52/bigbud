//! U23 host-key wire formats. Each accepted type is validated exactly: the
//! blob is the RFC 4253/5656 public-key encoding with no trailing bytes.

use super::KeyType;

/// Smallest RSA modulus accepted, matching OpenSSH's `RequiredRSASize`.
const MIN_RSA_BITS: usize = 1024;
const MAX_RSA_BITS: usize = 16_384;

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn string(&mut self) -> Option<&'a [u8]> {
        let (len, rest) = self.0.split_first_chunk::<4>()?;
        let len = usize::try_from(u32::from_be_bytes(*len)).ok()?;
        let (value, rest) = (rest.get(..len)?, rest.get(len..)?);
        self.0 = rest;
        Some(value)
    }

    fn done(&self) -> bool {
        self.0.is_empty()
    }
}

/// The key type a complete, well-formed blob encodes, if it is one we accept.
pub(super) fn validate(blob: &[u8]) -> Option<KeyType> {
    let mut reader = Reader(blob);
    let kind = KeyType::parse(std::str::from_utf8(reader.string()?).ok()?)?;
    let valid = match kind {
        KeyType::Ed25519 => reader.string()?.len() == 32,
        KeyType::EcdsaP256 | KeyType::EcdsaP384 | KeyType::EcdsaP521 => {
            let (curve, point_len) = match kind {
                KeyType::EcdsaP256 => (&b"nistp256"[..], 65),
                KeyType::EcdsaP384 => (&b"nistp384"[..], 97),
                _ => (&b"nistp521"[..], 133),
            };
            let point = (reader.string()? == curve).then(|| reader.string())??;
            point.len() == point_len && point.first() == Some(&4)
        }
        KeyType::Rsa => {
            let exponent = reader.string()?;
            let modulus = reader.string()?;
            positive_mpint(exponent).is_some_and(|bits| (2..=64).contains(&bits))
                && positive_mpint(modulus)
                    .is_some_and(|bits| (MIN_RSA_BITS..=MAX_RSA_BITS).contains(&bits))
        }
    };
    (valid && reader.done()).then_some(kind)
}

/// Bit length of a minimally encoded, positive SSH mpint.
fn positive_mpint(bytes: &[u8]) -> Option<usize> {
    let (&first, rest) = bytes.split_first()?;
    if first & 0x80 != 0 {
        return None;
    }
    let (lead, body) = if first == 0 {
        // A leading zero is only for a set high bit in the next byte.
        let (&next, _) = rest.split_first()?;
        if next & 0x80 == 0 {
            return None;
        }
        (next, rest)
    } else {
        (first, bytes)
    };
    let tail = body.len().checked_sub(1)?;
    Some(tail * 8 + (8 - lead.leading_zeros() as usize))
}
