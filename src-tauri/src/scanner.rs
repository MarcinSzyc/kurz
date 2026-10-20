//! Parallel disk scanner that builds an in-memory tree of sizes.
//!
//! Sizes are allocated bytes on disk (`st_blocks * 512`), the same number `du`
//! reports, so sparse files and compressed files are not overcounted. Symlinks
//! are never followed, other filesystems (mount points) are skipped, and files
//! with several hard links are counted once.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rayon::prelude::*;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Debug)]
pub struct Node {
    pub name: Box<str>,
    pub kind: Kind,
    /// Allocated bytes of this entry and everything below it.
    pub size: u64,
    /// Number of files (non-directories) below this entry, itself included.
    pub files: u64,
    /// Sorted by size, largest first.
    pub children: Vec<Node>,
}

impl Node {
    /// Finds a descendant by a path relative to this node.
    pub fn find(&self, relative: &Path) -> Option<&Node> {
        let mut node = self;
        for component in relative.components() {
            match component {
                Component::Normal(name) => {
                    let name = name.to_str()?;
                    node = node.children.iter().find(|c| &*c.name == name)?;
                }
                Component::CurDir => {}
                _ => return None,
            }
        }
        Some(node)
    }
}

/// Counters updated while scanning, safe to read from another thread.
#[derive(Debug, Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    /// Entries that could not be read, usually because of missing permissions.
    pub errors: AtomicU64,
}

struct Ctx<'a> {
    root_dev: u64,
    cancel: &'a AtomicBool,
    progress: &'a Progress,
    seen_hard_links: Mutex<HashSet<(u64, u64)>>,
}

impl Ctx<'_> {
    /// Allocated size of an entry, or 0 if a hard link to it was already counted.
    fn allocated(&self, meta: &Metadata) -> u64 {
        if !meta.is_dir() && meta.nlink() > 1 {
            let key = (meta.dev(), meta.ino());
            if !self.seen_hard_links.lock().unwrap().insert(key) {
                return 0;
            }
        }
        meta.blocks() * 512
    }
}

/// Scans `root` and returns its tree. Returns `None` if the scan was cancelled.
pub fn scan(root: &Path, cancel: &AtomicBool, progress: &Progress) -> std::io::Result<Option<Node>> {
    let meta = fs::symlink_metadata(root)?;
    let ctx = Ctx {
        root_dev: meta.dev(),
        cancel,
        progress,
        seen_hard_links: Mutex::new(HashSet::new()),
    };
    let name = root.file_name().map_or_else(|| root.to_string_lossy(), |n| n.to_string_lossy());
    let node = scan_entry(root, name.into(), &meta, &ctx);
    Ok((!cancel.load(Ordering::Relaxed)).then_some(node))
}

fn scan_entry(path: &Path, name: Box<str>, meta: &Metadata, ctx: &Ctx) -> Node {
    let size = ctx.allocated(meta);
    let file_type = meta.file_type();

    if !file_type.is_dir() {
        ctx.progress.files.fetch_add(1, Ordering::Relaxed);
        ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
        let kind = if file_type.is_file() {
            Kind::File
        } else if file_type.is_symlink() {
            Kind::Symlink
        } else {
            Kind::Other
        };
        return Node { name, kind, size, files: 1, children: Vec::new() };
    }

    ctx.progress.dirs.fetch_add(1, Ordering::Relaxed);
    ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
    let mut dir = Node { name, kind: Kind::Dir, size, files: 0, children: Vec::new() };

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            ctx.progress.errors.fetch_add(1, Ordering::Relaxed);
            return dir;
        }
    };

    // DirEntry::metadata does not follow symlinks.
    let entries: Vec<_> = entries
        .filter_map(|entry| match entry.and_then(|e| Ok((e.file_name(), e.metadata()?))) {
            Ok(entry) => Some(entry),
            Err(_) => {
                ctx.progress.errors.fetch_add(1, Ordering::Relaxed);
                None
            }
        })
        // Don't descend into other volumes mounted below the root.
        .filter(|(_, meta)| meta.dev() == ctx.root_dev)
        .collect();

    dir.children = entries
        .into_par_iter()
        .map(|(file_name, meta)| {
            if ctx.cancel.load(Ordering::Relaxed) {
                return None;
            }
            let child_path = path.join(&file_name);
            Some(scan_entry(&child_path, file_name.to_string_lossy().into(), &meta, ctx))
        })
        .while_some()
        .collect();

    dir.children.sort_unstable_by_key(|c| Reverse(c.size));
    dir.size += dir.children.iter().map(|c| c.size).sum::<u64>();
    dir.files = dir.children.iter().map(|c| c.files).sum();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn write(path: &Path, bytes: usize) {
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    fn scan_ok(root: &Path) -> Node {
        scan(root, &AtomicBool::new(false), &Progress::default()).unwrap().unwrap()
    }

    #[test]
    fn sums_sizes_and_counts_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("a")).unwrap();
        write(&tmp.path().join("a/big.bin"), 1_000_000);
        write(&tmp.path().join("small.txt"), 10);

        let root = scan_ok(tmp.path());

        assert_eq!(root.files, 2);
        assert!(root.size >= 1_000_000);
        assert_eq!(&*root.children[0].name, "a", "children sorted by size");
        assert_eq!(root.size, root.children.iter().map(|c| c.size).sum::<u64>() + fs::metadata(tmp.path()).unwrap().blocks() * 512);
    }

    #[test]
    fn counts_hard_links_once() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a.bin"), 1_000_000);
        let one = scan_ok(tmp.path()).size;

        fs::hard_link(tmp.path().join("a.bin"), tmp.path().join("b.bin")).unwrap();
        let both = scan_ok(tmp.path());

        assert_eq!(both.files, 2);
        assert_eq!(both.size, one);
    }

    #[test]
    fn does_not_follow_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("huge.bin"), 2_000_000);
        symlink(outside.path(), tmp.path().join("link")).unwrap();

        let root = scan_ok(tmp.path());

        let link = root.find(Path::new("link")).unwrap();
        assert_eq!(link.kind, Kind::Symlink);
        assert!(root.size < 2_000_000);
    }

    #[test]
    fn counts_unreadable_dirs_as_errors() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        fs::create_dir(&locked).unwrap();
        write(&locked.join("x"), 10);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let progress = Progress::default();
        let root = scan(tmp.path(), &AtomicBool::new(false), &progress).unwrap().unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(progress.errors.load(Ordering::Relaxed), 1);
        assert!(root.find(Path::new("locked")).unwrap().children.is_empty());
    }

    #[test]
    fn returns_none_when_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a"), 10);
        let result = scan(tmp.path(), &AtomicBool::new(true), &Progress::default()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn finds_nested_nodes() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("x/y")).unwrap();
        write(&tmp.path().join("x/y/z.txt"), 5);

        let root = scan_ok(tmp.path());

        assert_eq!(root.find(Path::new("x/y/z.txt")).unwrap().kind, Kind::File);
        assert!(root.find(Path::new("x/nope")).is_none());
        assert!(root.find(Path::new("../x")).is_none());
    }
}
