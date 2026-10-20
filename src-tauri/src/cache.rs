//! The last scan, saved so Kurz opens with it instead of an empty screen.
//!
//! Keeps every folder, files of 1 MB or more, and the small files rules look for (`package.json`,
//! `Cargo.toml`). Smaller files stay counted in their folder's size, so totals don't change, but
//! aren't stored one by one: a home folder with millions of files saves in a few MB, compressed.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

use crate::scanner::{Kind, Node};

const MAGIC: &[u8; 6] = b"KURZ\x00\x01";
/// Files smaller than this are folded into their folder.
const MIN_FILE: u64 = 1_000_000;
/// Small files the rules need to see.
const MARKERS: &[&str] = &["package.json", "Cargo.toml"];

/// What was saved with the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// Unix seconds.
    pub scanned_at: i64,
    pub files: u64,
    pub dirs: u64,
    pub errors: u64,
}

fn kept(node: &Node) -> bool {
    node.kind == Kind::Dir || node.size >= MIN_FILE || MARKERS.contains(&&*node.name)
}

fn write_node(w: &mut impl Write, node: &Node) -> io::Result<()> {
    let name = node.name.as_bytes();
    w.write_all(&(name.len() as u16).to_le_bytes())?;
    w.write_all(name)?;
    w.write_all(&[match node.kind {
        Kind::Dir => 0,
        Kind::File => 1,
        Kind::Symlink => 2,
        Kind::Other => 3,
    }])?;
    w.write_all(&node.size.to_le_bytes())?;
    w.write_all(&node.files.to_le_bytes())?;
    w.write_all(&node.modified.to_le_bytes())?;
    let children: Vec<&Node> = node.children.iter().filter(|c| kept(c)).collect();
    w.write_all(&(children.len() as u32).to_le_bytes())?;
    for child in children {
        write_node(w, child)?;
    }
    Ok(())
}

fn read_exact<const N: usize>(r: &mut impl Read) -> io::Result<[u8; N]> {
    let mut buf = [0; N];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn read_node(r: &mut impl Read) -> io::Result<Node> {
    let len = u16::from_le_bytes(read_exact(r)?) as usize;
    let mut name = vec![0; len];
    r.read_exact(&mut name)?;
    let kind = match read_exact::<1>(r)?[0] {
        0 => Kind::Dir,
        1 => Kind::File,
        2 => Kind::Symlink,
        _ => Kind::Other,
    };
    let size = u64::from_le_bytes(read_exact(r)?);
    let files = u64::from_le_bytes(read_exact(r)?);
    let modified = i64::from_le_bytes(read_exact(r)?);
    let count = u32::from_le_bytes(read_exact(r)?) as usize;
    let mut children = Vec::with_capacity(count.min(1 << 16));
    for _ in 0..count {
        children.push(read_node(r)?);
    }
    let name = String::from_utf8(name).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Node { name: name.into(), kind, size, files, modified, children })
}

/// Saves the tree scanned at `root`. Writes to a temporary file first, so a crash keeps the old one.
pub fn save(path: &Path, root: &Path, tree: &Node, stats: Stats) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut w = GzEncoder::new(BufWriter::new(File::create(&tmp)?), Compression::fast());
        w.write_all(MAGIC)?;
        let root = root.to_string_lossy();
        w.write_all(&(root.len() as u16).to_le_bytes())?;
        w.write_all(root.as_bytes())?;
        for v in [stats.scanned_at as u64, stats.files, stats.dirs, stats.errors] {
            w.write_all(&v.to_le_bytes())?;
        }
        write_node(&mut w, tree)?;
        w.finish()?.flush()?;
    }
    fs::rename(tmp, path)
}

/// Loads a saved scan: its root, tree and stats. `None` if there is none or it can't be read.
pub fn load(path: &Path) -> Option<(PathBuf, Node, Stats)> {
    let mut r = GzDecoder::new(BufReader::new(File::open(path).ok()?));
    if &read_exact::<6>(&mut r).ok()? != MAGIC {
        return None;
    }
    let len = u16::from_le_bytes(read_exact(&mut r).ok()?) as usize;
    let mut root = vec![0; len];
    r.read_exact(&mut root).ok()?;
    let mut v = [0u64; 4];
    for x in &mut v {
        *x = u64::from_le_bytes(read_exact(&mut r).ok()?);
    }
    let tree = read_node(&mut r).ok()?;
    let stats = Stats { scanned_at: v[0] as i64, files: v[1], dirs: v[2], errors: v[3] };
    Some((PathBuf::from(String::from_utf8(root).ok()?), tree, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size: u64) -> Node {
        Node { name: name.into(), kind: Kind::File, size, files: 1, modified: 7, children: vec![] }
    }

    fn dir(name: &str, children: Vec<Node>) -> Node {
        let size = children.iter().map(|c| c.size).sum::<u64>() + 4096;
        let files = children.iter().map(|c| c.files).sum();
        Node { name: name.into(), kind: Kind::Dir, size, files, modified: 9, children }
    }

    #[test]
    fn round_trips_and_folds_small_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("scan.bin");
        let tree = dir(
            "me",
            vec![
                dir("proj", vec![file("package.json", 300), file("tiny.txt", 10), file("big.bin", 5_000_000), dir("node_modules", vec![])]),
                file("żółw.mov", 2_000_000),
            ],
        );
        let stats = Stats { scanned_at: 1_800_000_000, files: 4, dirs: 3, errors: 2 };

        save(&path, Path::new("/Users/me"), &tree, stats).unwrap();
        let (root, loaded, loaded_stats) = load(&path).unwrap();

        assert_eq!(root, PathBuf::from("/Users/me"));
        assert_eq!(loaded_stats, stats);
        assert_eq!((loaded.size, loaded.files), (tree.size, tree.files), "totals are kept");
        let proj = loaded.find(Path::new("proj")).unwrap();
        let names: Vec<&str> = proj.children.iter().map(|c| &*c.name).collect();
        assert_eq!(names, vec!["package.json", "big.bin", "node_modules"], "tiny.txt is folded, markers stay");
        assert_eq!(proj.size, tree.find(Path::new("proj")).unwrap().size);
        assert!(loaded.find(Path::new("żółw.mov")).is_some(), "non-ASCII names survive");
    }

    #[test]
    fn ignores_missing_or_foreign_files() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load(&tmp.path().join("none.bin")).is_none());
        fs::write(tmp.path().join("junk.bin"), b"not a scan").unwrap();
        assert!(load(&tmp.path().join("junk.bin")).is_none());
    }
}
