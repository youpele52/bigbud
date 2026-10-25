use super::{
    fs_handles::Directory,
    fs_read, fs_write,
    protocol::{hex, unhex},
};
use std::io;

fn text(value: &str) -> io::Result<String> {
    String::from_utf8(unhex(value)?).map_err(io::Error::other)
}
fn privacy(value: &str) -> io::Result<bool> {
    match value {
        "private" => Ok(true),
        "public" => Ok(false),
        _ => Err(io::Error::other("privacy rejected")),
    }
}

/// One bounded operation owns its complete handle lifetime; no reusable cross-process handle tokens.
pub(super) fn dispatch(value: &str) -> io::Result<String> {
    let fields: Vec<_> = value.split('\t').collect();
    match fields.as_slice() {
        ["1", "DIR", path, mode, expected] => {
            let dir = Directory::open(&text(path)?, expected, privacy(mode)?)?;
            Ok(format!("OK\t{}", dir.id))
        }
        ["1", "LIST", path, mode, expected] => {
            let dir = Directory::open(&text(path)?, expected, privacy(mode)?)?;
            let names = fs_read::list(&dir)?;
            let mut result = format!("OK\t{}", dir.id);
            for name in names {
                result.push('\t');
                result.push_str(&hex(name.as_bytes()));
            }
            Ok(result)
        }
        ["1", "READ", path, expected, name, mode, max] => {
            let dir = Directory::open(&text(path)?, expected, false)?;
            let value = fs_read::read(
                &dir,
                &text(name)?,
                privacy(mode)?,
                max.parse().map_err(io::Error::other)?,
            )?;
            dir.revalidate()?;
            Ok(format!(
                "OK\t{}\t{}\t{}",
                value.id,
                value.hash,
                hex(&value.bytes)
            ))
        }
        ["1", "CREATE", path, expected, name, staging, bytes] => {
            if *expected == "-" {
                return Err(io::Error::other("parent identity required"));
            }
            let dir = Directory::open(&text(path)?, expected, false)?;
            let (id, hash) = fs_write::create(&dir, &text(name)?, &text(staging)?, &unhex(bytes)?)?;
            Ok(format!("OK\t{id}\t{hash}"))
        }
        ["1", "MKDIR", path, expected, name, staging] => {
            if *expected == "-" {
                return Err(io::Error::other("parent identity required"));
            }
            let dir = Directory::open(&text(path)?, expected, false)?;
            let id = fs_write::mkdir(&dir, &text(name)?, &text(staging)?)?;
            Ok(format!("OK\t{id}"))
        }
        [
            "1",
            "PUBLISH",
            path,
            expected,
            source,
            source_id,
            source_hash,
            target,
            target_id,
            target_hash,
        ] => {
            if *expected == "-" {
                return Err(io::Error::other("parent identity required"));
            }
            let dir = Directory::open(&text(path)?, expected, false)?;
            let (id, hash) = fs_write::publish(
                &dir,
                &text(source)?,
                source_id,
                source_hash,
                &text(target)?,
                target_id,
                target_hash,
            )?;
            Ok(format!("OK\t{id}\t{hash}"))
        }
        ["1", "REMOVE", path, expected, name, id, hash] => {
            if *expected == "-" {
                return Err(io::Error::other("parent identity required"));
            }
            let dir = Directory::open(&text(path)?, expected, false)?;
            fs_write::remove(&dir, &text(name)?, id, hash)?;
            Ok("OK".into())
        }
        _ => Err(io::Error::other("filesystem request rejected")),
    }
}
