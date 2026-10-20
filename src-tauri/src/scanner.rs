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
use std::path::{Component, Path, PathBuf};
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
    /// Latest modification time (Unix seconds) of this entry or anything below it.
    pub modified: i64,
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

    /// Detaches the descendant at `relative` and takes its size and file count off every ancestor.
    pub fn remove(&mut self, relative: &Path) -> Option<Node> {
        let mut names = relative.components().filter_map(|c| match c {
            Component::Normal(n) => n.to_str(),
            _ => None,
        });
        let first = names.next()?;
        let rest: PathBuf = names.collect();
        let index = self.children.iter().position(|c| &*c.name == first)?;
        let removed = if rest.as_os_str().is_empty() { self.children.remove(index) } else { self.children[index].remove(&rest)? };
        self.size -= removed.size;
        self.files -= removed.files;
        Some(removed)
    }

    /// Puts a node removed with `remove` back at `relative`, the path it was removed from.
    pub fn restore(&mut self, relative: &Path, node: Node) -> bool {
        let parents: Vec<&str> = match relative.parent() {
            Some(parent) => parent.components().filter_map(|c| c.as_os_str().to_str()).collect(),
            None => return false,
        };
        let mut chain = vec![];
        let mut current: &mut Node = self;
        for name in parents {
            chain.push(name);
            match current.children.iter_mut().position(|c| &*c.name == name) {
                Some(i) => current = &mut current.children[i],
                None => return false,
            }
        }
        // Walk again to add the sizes, now that the parent is known to exist.
        let (size, files) = (node.size, node.files);
        let mut current: &mut Node = self;
        current.size += size;
        current.files += files;
        for name in chain {
            let i = current.children.iter().position(|c| &*c.name == name).unwrap();
            current = &mut current.children[i];
            current.size += size;
            current.files += files;
        }
        let at = current.children.partition_point(|c| c.size >= size);
        current.children.insert(at, node);
        true
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
    let ctx = Ctx { root_dev: meta.dev(), cancel, progress, seen_hard_links: Mutex::new(HashSet::new()) };
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
        return Node { name, kind, size, files: 1, modified: meta.mtime(), children: Vec::new() };
    }

    ctx.progress.dirs.fetch_add(1, Ordering::Relaxed);
    ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
    let mut dir = Node { name, kind: Kind::Dir, size, files: 0, modified: meta.mtime(), children: Vec::new() };

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
    dir.modified = dir.children.iter().map(|c| c.modified).fold(dir.modified, i64::max);
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
    fn tracks_the_latest_change_below_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("a")).unwrap();
        write(&tmp.path().join("a/old.txt"), 10);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(90 * 86_400);
        fs::File::options().write(true).open(tmp.path().join("a/old.txt")).unwrap().set_modified(old).unwrap();
        fs::File::open(tmp.path().join("a")).unwrap().set_modified(old).unwrap();

        let root = scan_ok(tmp.path());

        let a = root.find(Path::new("a")).unwrap();
        let old_secs = old.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        assert_eq!(a.modified, old_secs);
        assert!(root.modified > old_secs, "the root itself changed just now");
    }

    #[test]
    fn removes_and_restores_subtrees() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("x/y")).unwrap();
        write(&tmp.path().join("x/y/big.bin"), 500_000);
        write(&tmp.path().join("x/small.txt"), 10);
        let mut root = scan_ok(tmp.path());
        let (size, files) = (root.size, root.files);

        let removed = root.remove(Path::new("x/y")).unwrap();

        assert_eq!(root.size, size - removed.size);
        assert_eq!(root.files, files - 1);
        assert!(root.find(Path::new("x/y")).is_none());
        assert!(root.remove(Path::new("x/nope")).is_none());

        assert!(root.restore(Path::new("x/y"), removed));
        assert_eq!((root.size, root.files), (size, files));
        assert!(root.find(Path::new("x/y/big.bin")).is_some());
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
