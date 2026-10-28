use super::{
    account::{Account, current_uid},
    layout::{ROOT_LEAF, RootLayout},
};
use crate::native_fs::{
    acl::{self, Policy},
    descriptor::{open_at, same_named, stat},
    invalid,
};
use std::{ffi::CString, fs::File, io, os::fd::AsRawFd};

#[cfg(test)]
use std::{os::unix::ffi::OsStrExt, path::Path};

#[derive(Debug)]
struct Node {
    file: File,
    name: CString,
    owner: u32,
    private: bool,
}
/// Owns validated ancestry through the single fixed per-account durable root.
/// No descriptor/path escape, Clone, public fields or caller-provided identity.
/// Storage ownership is not login identity, admission, or a BootstrapPermit.
///
/// ```compile_fail
/// use bigbud_computer_use::guard::DurableRoot;
/// let root = DurableRoot { uid: 501, nodes: vec![] };
/// ```
pub struct DurableRoot {
    uid: u32,
    anchor: Node,
    nodes: Vec<Node>,
}
impl std::fmt::Debug for DurableRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DurableRoot")
            .field("uid", &self.uid)
            .finish_non_exhaustive()
    }
}
impl DurableRoot {
    /// Dormant explicit filesystem acquisition. May create missing fixed suffix
    /// directories, never migrate/chmod/repair existing user state. Not invoked
    /// by any role or by tests (tests use isolated descriptor fixtures).
    pub fn acquire_current_user() -> io::Result<Self> {
        Self::acquire_current_user_in(&RootLayout::Standard)
    }

    /// As [`Self::acquire_current_user`], for an explicit layout. Only debug
    /// builds can construct a development layout.
    pub fn acquire_current_user_in(layout: &RootLayout) -> io::Result<Self> {
        let account = Account::current()?;
        Self::acquire(account, layout)
    }

    fn acquire(account: Account, layout: &RootLayout) -> io::Result<Self> {
        let names = home_components(&account.home)?;
        let file = open_at(libc::AT_FDCWD, c"/")?;
        let mut root = Self {
            uid: account.uid,
            anchor: Node {
                file,
                name: CString::new("/").map_err(|_| invalid())?,
                owner: 0,
                private: false,
            },
            nodes: Vec::new(),
        };
        root.validate()?;
        root.walk_home(&names, layout)?;
        Ok(root)
    }

    fn walk_home(&mut self, names: &[CString], layout: &RootLayout) -> io::Result<()> {
        for (index, name) in names.iter().enumerate() {
            self.descend(name.clone(), false, false, index + 1 == names.len())?;
        }
        self.suffix(&layout.suffix(names)?)
    }

    fn suffix(&mut self, names: &[CString]) -> io::Result<()> {
        let leaf = names.len().checked_sub(1).ok_or_else(invalid)?;
        if names.get(leaf).map(|name| name.as_bytes()) != Some(ROOT_LEAF.as_bytes()) {
            return Err(invalid());
        }
        for (index, name) in names.iter().enumerate() {
            self.descend(name.clone(), true, index == leaf, true)?;
        }
        self.validate()
    }

    fn descend(
        &mut self,
        name: CString,
        create: bool,
        private: bool,
        user_owned: bool,
    ) -> io::Result<()> {
        self.validate()?;
        let parent = self.directory();
        let mut created = false;
        if create {
            // SAFETY: retained parent, single validated component. EEXIST is
            // validated below, never chmod/adopt a symlink or unsafe directory.
            if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
                created = true;
            } else if io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err(io::Error::last_os_error());
            }
        }
        let file = open_at(parent.as_raw_fd(), &name)?;
        let owner = stat(&file)?.st_uid;
        if (owner != 0 || user_owned) && owner != self.uid {
            return Err(invalid());
        }
        check(&file, owner, private)?;
        same_named(parent, &name, &stat(&file)?)?;
        if created {
            file.sync_all()?;
            parent.sync_all()?;
        }
        self.nodes.push(Node {
            file,
            name,
            owner,
            private,
        });
        self.validate()
    }

    pub fn validate(&self) -> io::Result<()> {
        if current_uid()? != self.uid {
            return Err(invalid());
        }
        check(&self.anchor.file, self.anchor.owner, self.anchor.private)?;
        let mut parent = &self.anchor.file;
        for node in &self.nodes {
            check(&node.file, node.owner, node.private)?;
            same_named(parent, &node.name, &stat(&node.file)?)?;
            parent = &node.file;
        }
        Ok(())
    }

    /// Valid only while this descriptor owner is retained and revalidated.
    pub fn uid(&self) -> u32 {
        self.uid
    }

    pub fn lock(self) -> Result<super::super::ControllingLock, super::super::LockError> {
        super::super::ControllingLock::acquire(self)
    }

    pub(crate) fn directory(&self) -> &File {
        // No children means the retained anchor itself, never a path fallback.
        self.nodes
            .last()
            .map_or(&self.anchor.file, |node| &node.file)
    }

    #[cfg(test)]
    pub(super) fn fixture_home(base: &Path, home: &Path) -> io::Result<Self> {
        Self::fixture_home_in(base, home, &RootLayout::Standard)
    }

    #[cfg(test)]
    pub(super) fn fixture_home_in(
        base: &Path,
        home: &Path,
        layout: &RootLayout,
    ) -> io::Result<Self> {
        let mut root = Self::fixture(base, false)?;
        root.walk_home(&home_components(home)?, layout)?;
        Ok(root)
    }

    #[cfg(test)]
    pub(crate) fn fixture(path: &Path, suffix: bool) -> io::Result<Self> {
        let name = CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid())?;
        let file = open_at(libc::AT_FDCWD, &name)?;
        let mut root = Self {
            uid: current_uid()?,
            anchor: Node {
                file,
                name,
                owner: current_uid()?,
                private: true,
            },
            nodes: Vec::new(),
        };
        root.validate()?;
        if suffix {
            root.suffix(&RootLayout::Standard.suffix(&[])?)?;
        }
        Ok(root)
    }
}

fn check(file: &File, owner: u32, private: bool) -> io::Result<()> {
    let metadata = stat(file)?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
        || metadata.st_uid != owner
        || metadata.st_mode & 0o7022 != 0
        || (private && metadata.st_mode & 0o777 != 0o700)
    {
        return Err(invalid());
    }
    acl::validate(
        file,
        if private {
            Policy::Private
        } else {
            Policy::Ancestor
        },
    )
}

pub(super) use crate::native_fs::descriptor::absolute_components as home_components;

#[cfg(test)]
mod owner_tests {
    use super::*;
    use crate::guard::test_support::TestDirectory;

    #[test]
    fn actual_directory_owner_mismatch_is_rejected() {
        let fixture = TestDirectory::new();
        let file = File::open(&fixture.0).unwrap();
        let uid = current_uid().unwrap();
        check(&file, uid, true).unwrap();
        assert!(check(&file, uid + 1, true).is_err());
    }
}
