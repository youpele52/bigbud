use super::{MAX_BYTES, MAX_FILES, Member, Result, files, invalid};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn hash(path: &Path, expected: &Member, buffer: &mut [u8]) -> Result<Metadata> {
    files::canonical(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let before = file.metadata()?;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != files::uid()?
        || before.mode() & 0o7777 != expected.mode
        || before.len() != expected.size
    {
        return Err(invalid());
    }
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    loop {
        let count = file.read(buffer)?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .filter(|n| *n <= expected.size && *n <= MAX_BYTES)
            .ok_or_else(invalid)?;
        digest.update(buffer.get(..count).ok_or_else(invalid)?);
    }
    if size != expected.size
        || format!("{:x}", digest.finalize()) != expected.sha
        || !same(&before, &file.metadata()?)
        || !same(&before, &fs::symlink_metadata(path)?)
    {
        return Err(invalid());
    }
    Ok(before)
}
pub(super) fn verify(
    root: &Path,
    members: &BTreeMap<String, Member>,
    expected_root: (u64, u64, i128),
) -> Result<()> {
    verify_observed(root, members, expected_root, || Ok(()))
}

fn verify_observed(
    root: &Path,
    members: &BTreeMap<String, Member>,
    expected_root: (u64, u64, i128),
    after_identity: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let identity = fs::symlink_metadata(root)?;
    if (
        identity.dev(),
        identity.ino(),
        i128::from(identity.ctime()) * 1_000_000_000 + i128::from(identity.ctime_nsec()),
    ) != expected_root
    {
        return Err(invalid());
    }
    after_identity()?;
    let mut expected_directories = BTreeSet::from([root.to_owned()]);
    for path in members.keys() {
        let mut parent = Path::new(path).parent();
        while let Some(relative) = parent {
            expected_directories.insert(root.join(relative));
            if expected_directories.len() > 32768 {
                return Err(invalid());
            }
            parent = relative.parent();
        }
    }
    let mut stack = vec![(root.to_owned(), 0_usize)];
    let mut directories = BTreeMap::new();
    let mut observed = BTreeMap::new();
    let mut buffer = [0_u8; 64 * 1024];
    while let Some((directory, depth)) = stack.pop() {
        if depth > 32 || directories.len() >= 32768 || !expected_directories.contains(&directory) {
            return Err(invalid());
        }
        files::directory(&directory, &[0o700])?;
        directories.insert(directory.clone(), fs::symlink_metadata(&directory)?);
        for entry in fs::read_dir(&directory)? {
            let path = entry?.path();
            let info = fs::symlink_metadata(&path)?;
            if info.is_dir() {
                if stack.len() + directories.len() >= 32768 {
                    return Err(invalid());
                }
                stack.push((path, depth + 1));
            } else {
                if observed.len() >= MAX_FILES {
                    return Err(invalid());
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| invalid())?
                    .to_str()
                    .ok_or_else(invalid)?;
                let expected = members.get(relative).ok_or_else(invalid)?;
                observed.insert(path.clone(), hash(&path, expected, &mut buffer)?);
            }
        }
    }
    if observed.len() != members.len() || directories.len() != expected_directories.len() {
        return Err(invalid());
    }
    // Final member checks precede final directory checks to detect concurrent additions/replacements.
    for (path, before) in observed.iter().chain(directories.iter()) {
        if !same(before, &fs::symlink_metadata(path)?) {
            return Err(invalid());
        }
    }
    if !same(&identity, &fs::symlink_metadata(root)?) {
        return Err(invalid());
    }
    files::canonical(root)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::backend_service::tests::fixture::{Fixture, mode, write};
    #[test]
    fn root_replacement_after_initial_identity_cannot_be_adopted() {
        let f = Fixture::new();
        let root = f.config.node_binary.parent().unwrap();
        let original = fs::metadata(root).unwrap();
        let expected = (
            original.dev(),
            original.ino(),
            i128::from(original.ctime()) * 1_000_000_000 + i128::from(original.ctime_nsec()),
        );
        let mut members = BTreeMap::new();
        for name in ["backend.mjs", "node"] {
            let path = root.join(name);
            let bytes = fs::read(&path).unwrap();
            members.insert(
                name.to_owned(),
                Member {
                    sha: format!("{:x}", Sha256::digest(&bytes)),
                    size: bytes.len() as u64,
                    mode: if name == "node" { 0o700 } else { 0o600 },
                },
            );
        }
        let result = verify_observed(root, &members, expected, || {
            let prior = f.root.join("replaced-root");
            fs::rename(root, &prior)?;
            fs::create_dir(root)?;
            mode(root, 0o700);
            for (name, member) in &members {
                write(&root.join(name), &fs::read(prior.join(name))?, member.mode);
            }
            Ok(())
        });
        assert!(result.is_err());
    }
}
