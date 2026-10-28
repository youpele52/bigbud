use super::{macho, metadata::Snapshot};
use crate::native_fs::{
    current_uid,
    descriptor::{absolute_components, open_at, same_named, stat},
    invalid, storage,
};
use std::{ffi::CString, fs::File, io, os::fd::AsRawFd, path::Path};

struct Node {
    file: File,
    name: CString,
    snapshot: Snapshot,
}
/// Owns only storage/structure preflight evidence for an untrusted path. Move-only,
/// without Debug/path/fd accessors, execution methods or caller verification flags.
/// Inspection is read-only; unsupported layouts/unsafe ancestry refuse.
///
/// ```compile_fail
/// use bigbud_computer_use::owner::image_preflight::ImagePreflight;
/// let image = ImagePreflight { uid: 501, nodes: vec![] };
/// ```
pub struct ImagePreflight {
    uid: u32,
    anchor: Node,
    nodes: Vec<Node>,
    /// The exact inspected absolute path (exec uses this, never another).
    path: std::path::PathBuf,
}
impl ImagePreflight {
    /// Candidate path is UNTRUSTED input, never first-party/launch authority.
    /// Retains / and every no-follow ancestry descriptor. No canonicalize, cwd,
    /// environment fallback, symlink following, creation or chmod is performed.
    pub fn inspect_candidate(path: &Path) -> io::Result<Self> {
        let names = absolute_components(path)?;
        let uid = current_uid()?;
        let file = open_at(libc::AT_FDCWD, c"/")?;
        let snapshot = Snapshot::read(&file, uid, false)?;
        Self::walk(
            uid,
            Node {
                file,
                name: CString::from(c"/"),
                snapshot,
            },
            names,
            path,
        )
    }

    /// The inspected path; only meaningful together with revalidation.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    fn walk(uid: u32, anchor: Node, names: Vec<CString>, path: &Path) -> io::Result<Self> {
        let mut image = Self {
            uid,
            anchor,
            nodes: Vec::new(),
            path: path.to_path_buf(),
        };
        for (index, name) in names.iter().enumerate() {
            let executable = index + 1 == names.len();
            let parent = image
                .nodes
                .last()
                .map_or(&image.anchor.file, |node| &node.file);
            let file = if executable {
                storage::open(parent, name, libc::O_RDONLY)?
            } else {
                open_at(parent.as_raw_fd(), name)?
            };
            let snapshot = Snapshot::read(&file, uid, executable)?;
            same_named(parent, name, &stat(&file)?)?;
            image.nodes.push(Node {
                file,
                name: name.clone(),
                snapshot,
            });
        }
        image.validate()?;
        Ok(image)
    }

    /// Rechecks retained ancestry, names, metadata and bounded host-image shape.
    /// A metadata match is NOT a content digest or an atomic dispatch guarantee.
    pub fn validate(&self) -> io::Result<()> {
        self.validate_storage()?;
        let image = self.nodes.last().ok_or_else(invalid)?;
        macho::validate(&image.file, image.snapshot.length()?)?;
        self.validate_storage()
    }

    fn validate_storage(&self) -> io::Result<()> {
        if current_uid()? != self.uid
            || Snapshot::read(&self.anchor.file, self.uid, false)? != self.anchor.snapshot
        {
            return Err(invalid());
        }
        // Also re-open / to detect replacement of the absolute lookup anchor.
        let root = open_at(libc::AT_FDCWD, c"/")?;
        same_named(&root, &self.anchor.name, &stat(&self.anchor.file)?)?;
        let mut parent = &self.anchor.file;
        for (index, node) in self.nodes.iter().enumerate() {
            if Snapshot::read(&node.file, self.uid, index + 1 == self.nodes.len())? != node.snapshot
            {
                return Err(invalid());
            }
            same_named(parent, &node.name, &stat(&node.file)?)?;
            parent = &node.file;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fixture(base: &Path, relative: &str) -> io::Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        let uid = current_uid()?;
        let name = CString::new(base.as_os_str().as_bytes()).map_err(|_| invalid())?;
        let file = open_at(libc::AT_FDCWD, &name)?;
        let snapshot = Snapshot::read(&file, uid, false)?;
        // Private fixture anchor bypasses only the mutable temporary ancestry.
        // It still retains/revalidates its actual named inode and all descendants.
        Self::walk(
            uid,
            Node {
                file,
                name,
                snapshot,
            },
            absolute_components(Path::new(&format!("/{relative}")))?,
            &base.join(relative),
        )
    }
}

/// Crate-private retained image descriptor + recorded length for hashing.
pub(super) fn retained_image(image: &ImagePreflight) -> io::Result<(&File, u64)> {
    let node = image.nodes.last().ok_or_else(invalid)?;
    Ok((&node.file, node.snapshot.length()?))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
