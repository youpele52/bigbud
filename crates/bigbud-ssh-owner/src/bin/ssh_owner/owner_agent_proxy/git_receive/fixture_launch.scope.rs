use super::{BRANCH, HOST, PORT, REMOTE_PATH, TrackedPushBinding, URL, USER, denied};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const ROOT_PREFIX: &str = "/tmp/bigbud-picker-linux-";
const MAX_OBJECTS: usize = 128;
const MAX_OBJECT_BYTES: u64 = 256 * 1024;
const CONFIG: &[u8] = b"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote \"origin\"]\n\turl = ssh://picker@127.0.0.1:22222/receive.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n";

pub(super) struct Scope {
    root: PathBuf,
    pub(super) worktree: PathBuf,
    git_dir: PathBuf,
    main: String,
    authority: Authority,
    uid: u32,
}

#[derive(Eq, PartialEq)]
struct Authority {
    root: (u64, u64),
    worktree: (u64, u64),
    git_dir: (u64, u64),
    known_hosts: FileStamp,
}

type FileStamp = ((u64, u64), u64, (i64, i64), (i64, i64));

impl Scope {
    pub(super) fn new(root: &Path) -> io::Result<Self> {
        if !valid_root(root) {
            return Err(denied());
        }
        // SAFETY: geteuid has no input and reads only the process credential.
        let uid = unsafe { libc::geteuid() };
        let worktree = root.join("client");
        let git_dir = worktree.join(".git");
        let authority = authority(root, &worktree, &git_dir, uid)?;
        let main = validate_repo(&git_dir, uid)?;
        Ok(Self {
            root: root.to_owned(),
            worktree,
            git_dir,
            main,
            authority,
            uid,
        })
    }

    pub(super) fn matches(&self, binding: &TrackedPushBinding) -> bool {
        let repo = &binding.repository;
        let destination = &binding.destination;
        self.worktree.as_os_str() == repo.worktree.as_str()
            && self.git_dir.as_os_str() == repo.git_dir.as_str()
            && self.git_dir.as_os_str() == repo.common_dir.as_str()
            && binding.remote_name == "origin"
            && binding.source_ref == BRANCH
            && binding.destination_ref == BRANCH
            && binding.source_oid == self.main
            && destination.host == HOST
            && destination.user == USER
            && destination.port == PORT
            && destination.repository_path == REMOTE_PATH
            && destination.effective_url == URL
    }

    pub(super) fn revalidate(&self) -> io::Result<()> {
        if authority(&self.root, &self.worktree, &self.git_dir, self.uid)? != self.authority
            || validate_repo(&self.git_dir, self.uid)? != self.main
        {
            return Err(denied());
        }
        Ok(())
    }
}

fn valid_root(root: &Path) -> bool {
    root.to_str()
        .and_then(|path| path.strip_prefix(ROOT_PREFIX))
        .is_some_and(|suffix| {
            (1..=64).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

fn authority(root: &Path, worktree: &Path, git_dir: &Path, uid: u32) -> io::Result<Authority> {
    for ancestor in ["/", "/tmp"] {
        let meta = fs::symlink_metadata(ancestor)?;
        // Bubblewrap's private root and /tmp are owned by the mapped fixture UID.
        // Only root can be trusted to provide a sticky shared writable ancestor.
        let root_sticky = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        if !meta.is_dir()
            || (meta.uid() != 0 && meta.uid() != uid)
            || (meta.mode() & 0o022 != 0 && !root_sticky)
        {
            return Err(denied());
        }
    }
    let root_meta = mode_dir(root, uid)?;
    if root_meta.mode() & 0o7777 != 0o700 {
        return Err(denied());
    }
    let worktree = id(&mode_dir(worktree, uid)?);
    let git_dir = id(&mode_dir(git_dir, uid)?);
    let known_hosts = bounded_file(&root.join("known_hosts"), uid, 4096)?;
    if known_hosts.mode() & 0o7777 != 0o600 || known_hosts.len() == 0 {
        return Err(denied());
    }
    Ok(Authority {
        root: id(&root_meta),
        worktree,
        git_dir,
        known_hosts: (
            id(&known_hosts),
            known_hosts.len(),
            (known_hosts.ctime(), known_hosts.ctime_nsec()),
            (known_hosts.mtime(), known_hosts.mtime_nsec()),
        ),
    })
}

fn validate_repo(git: &Path, uid: u32) -> io::Result<String> {
    for (name, path) in entries(git, 8)? {
        match name.as_str() {
            "HEAD" | "config" | "description" => {
                bounded_file(&path, uid, 4096)?;
            }
            "index" => {
                bounded_file(&path, uid, 16 * 1024)?;
            }
            "objects" | "refs" | "logs" => {
                mode_dir(&path, uid)?;
            }
            // No hooks, info/grafts, commondir, worktrees, shallow,
            // packed refs, config.worktree or other unchecked metadata.
            _ => return Err(denied()),
        }
    }
    if read_small(&git.join("config"), uid, 4096)? != CONFIG
        || read_small(&git.join("HEAD"), uid, 32)? != b"ref: refs/heads/main\n"
    {
        return Err(denied());
    }
    refs_or_logs(&git.join("refs"), uid, false)?;
    let logs = git.join("logs");
    if logs.try_exists()? {
        mode_dir(&logs, uid)?;
        for (name, path) in entries(&logs, 2)? {
            match name.as_str() {
                "HEAD" => {
                    bounded_file(&path, uid, 16 * 1024)?;
                }
                "refs" => refs_or_logs(&path, uid, true)?,
                _ => return Err(denied()),
            }
        }
    }
    let main = read_small(&git.join("refs/heads/main"), uid, 41)?;
    let main = main.strip_suffix(b"\n").ok_or_else(denied)?;
    if !hex(main, 40) || main.iter().all(|&b| b == b'0') {
        return Err(denied());
    }
    let main = std::str::from_utf8(main).map_err(|_| denied())?;
    let (fanout, object) = main.split_at(2);
    let objects = git.join("objects");
    mode_dir(&objects, uid)?;
    validate_objects(&objects, uid)?;
    bounded_file(&objects.join(fanout).join(object), uid, MAX_OBJECT_BYTES)?;
    Ok(main.to_owned())
}

fn refs_or_logs(path: &Path, uid: u32, logs: bool) -> io::Result<()> {
    mode_dir(path, uid)?;
    for (name, nested) in entries(path, 4)? {
        match name.as_str() {
            "heads" => branch_leaf(&nested, uid, logs)?,
            "tags" if !logs => {
                mode_dir(&nested, uid)?;
                entries(&nested, 0)?;
            }
            "remotes" => {
                mode_dir(&nested, uid)?;
                for (remote, leaf) in entries(&nested, 1)? {
                    if remote != "origin" {
                        return Err(denied());
                    }
                    branch_leaf(&leaf, uid, logs)?;
                }
            }
            _ => return Err(denied()),
        }
    }
    Ok(())
}

fn branch_leaf(path: &Path, uid: u32, logs: bool) -> io::Result<()> {
    mode_dir(path, uid)?;
    for (name, file) in entries(path, 1)? {
        if name != "main" {
            return Err(denied());
        }
        if logs {
            bounded_file(&file, uid, 16 * 1024)?;
        } else {
            let bytes = read_small(&file, uid, 41)?;
            if !bytes.strip_suffix(b"\n").is_some_and(|oid| hex(oid, 40)) {
                return Err(denied());
            }
        }
    }
    Ok(())
}

fn validate_objects(path: &Path, uid: u32) -> io::Result<()> {
    let mut count = 0;
    let mut bytes = 0;
    for (prefix, dir) in entries(path, MAX_OBJECTS + 2)? {
        mode_dir(&dir, uid)?;
        if matches!(prefix.as_str(), "info" | "pack") {
            // No alternates, partial clone/promisor data or packed stores.
            entries(&dir, 0)?;
            continue;
        }
        if !hex(prefix.as_bytes(), 2) {
            return Err(denied());
        }
        for (name, object) in entries(&dir, MAX_OBJECTS - count)? {
            if !hex(name.as_bytes(), 38) {
                return Err(denied());
            }
            count += 1;
            let object = bounded_file(&object, uid, MAX_OBJECT_BYTES - bytes)?;
            bytes += object.len();
        }
    }
    Ok(())
}

fn hex(value: &[u8], length: usize) -> bool {
    value.len() == length
        && value
            .iter()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

fn entries(path: &Path, max: usize) -> io::Result<Vec<(String, PathBuf)>> {
    fs::read_dir(path)?
        .take(max + 1)
        .enumerate()
        .map(|(index, entry)| {
            if index == max {
                return Err(denied());
            }
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| denied())?;
            Ok((name, entry.path()))
        })
        .collect()
}

fn mode_dir(path: &Path, uid: u32) -> io::Result<Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o7022 != 0 {
        return Err(denied());
    }
    Ok(meta)
}

fn bounded_file(path: &Path, uid: u32, max: u64) -> io::Result<Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file()
        || meta.uid() != uid
        || meta.mode() & 0o7022 != 0
        || meta.nlink() != 1
        || meta.len() > max
    {
        return Err(denied());
    }
    Ok(meta)
}

fn read_small(path: &Path, uid: u32, max: u64) -> io::Result<Vec<u8>> {
    let metadata = bounded_file(path, uid, max)?;
    let mut bytes = Vec::new();
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if id(&file.metadata()?) != id(&metadata) {
        return Err(denied());
    }
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(denied());
    }
    Ok(bytes)
}

fn id(meta: &Metadata) -> (u64, u64) {
    (meta.dev(), meta.ino())
}

#[cfg(test)]
pub(super) const FIXTURE_CONFIG: &[u8] = CONFIG;
