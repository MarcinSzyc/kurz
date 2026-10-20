//! Removes what the user chose: to the Trash or permanently, after re-checking every path.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use objc2_foundation::{NSFileManager, NSString, NSURL};
use serde::{Deserialize, Serialize};

use crate::rules;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Recoverable until the Trash is emptied.
    Trash,
    /// Frees the space right away; can't be undone.
    Delete,
}

/// Why a path may not be removed, checked again right before removing it.
pub fn check(path: &Path, home: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err("Not a plain absolute path".into());
    }
    let relative = path.strip_prefix(home).map_err(|_| "Outside your home folder")?;
    if relative.as_os_str().is_empty() {
        return Err("That's your whole home folder".into());
    }
    if rules::is_protected(&relative.to_string_lossy()) {
        return Err("Kurz never removes anything here".into());
    }
    fs::symlink_metadata(path).map_err(|_| "It no longer exists")?;
    // A symlinked parent could point anywhere: resolve it and check again.
    let parent = path.parent().ok_or("No parent folder")?;
    let real_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let real_home = fs::canonicalize(home).map_err(|e| e.to_string())?;
    if !real_parent.starts_with(&real_home) {
        return Err("It leads outside your home folder".into());
    }
    let real_relative = real_parent.strip_prefix(&real_home).unwrap().join(path.file_name().unwrap());
    if rules::is_protected(&real_relative.to_string_lossy()) {
        return Err("Kurz never removes anything here".into());
    }
    Ok(())
}

/// Moves `path` to the Trash and returns where it ended up there.
pub fn move_to_trash(path: &Path) -> io::Result<PathBuf> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let mut resulting: Option<objc2::rc::Retained<NSURL>> = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| io::Error::other(e.localizedDescription().to_string()))?;
    resulting
        .and_then(|url| url.path())
        .map(|p| PathBuf::from(p.to_string()))
        .ok_or_else(|| io::Error::other("The Trash didn't say where it put the item"))
}

/// Removes `path` for good. Symlinks are removed, never followed.
pub fn delete(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

/// Puts an item moved to the Trash back where it was.
pub fn restore(trashed: &Path, original: &Path) -> io::Result<()> {
    if fs::symlink_metadata(original).is_ok() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Something new is already at the original place"));
    }
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(trashed, original)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap();
        (tmp, home)
    }

    #[test]
    fn accepts_a_normal_folder_in_home() {
        let (_tmp, home) = setup();
        fs::create_dir_all(home.join(".npm/_cacache")).unwrap();
        assert_eq!(check(&home.join(".npm/_cacache"), &home), Ok(()));
    }

    #[test]
    fn rejects_unsafe_paths() {
        let (_tmp, home) = setup();
        fs::create_dir_all(home.join("Documents/taxes")).unwrap();
        assert!(check(&home, &home).is_err(), "home itself");
        assert!(check(Path::new("/etc"), &home).is_err(), "outside home");
        assert!(check(&home.join("Documents/taxes"), &home).is_err(), "protected");
        assert!(check(&home.join("gone"), &home).is_err(), "missing");
        assert!(check(&home.join("x/../Documents"), &home).is_err(), "dot-dot");
    }

    #[test]
    fn rejects_paths_reached_through_a_symlink_out_of_home() {
        let (_tmp, home) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("victim")).unwrap();
        symlink(outside.path(), home.join("link")).unwrap();
        fs::create_dir_all(home.join("Documents")).unwrap();
        symlink(home.join("Documents"), home.join("docs")).unwrap();
        fs::create_dir(home.join("Documents/secret")).unwrap();

        assert!(check(&home.join("link/victim"), &home).is_err());
        assert!(check(&home.join("docs/secret"), &home).is_err(), "protected place behind a symlink");
    }

    #[test]
    fn deletes_folders_and_only_the_link_of_a_symlink() {
        let (_tmp, home) = setup();
        fs::create_dir_all(home.join("cache/deep")).unwrap();
        fs::write(home.join("cache/deep/f"), b"x").unwrap();
        fs::create_dir(home.join("keep")).unwrap();
        fs::write(home.join("keep/f"), b"x").unwrap();
        symlink(home.join("keep"), home.join("cache/link")).unwrap();

        delete(&home.join("cache")).unwrap();

        assert!(!home.join("cache").exists());
        assert!(home.join("keep/f").exists(), "the symlink target survives");
    }

    #[test]
    fn restores_to_the_original_place_unless_taken() {
        let (_tmp, home) = setup();
        fs::create_dir(home.join("trashed")).unwrap();
        restore(&home.join("trashed"), &home.join("a/b")).unwrap();
        assert!(home.join("a/b").exists());

        fs::create_dir(home.join("again")).unwrap();
        assert!(restore(&home.join("again"), &home.join("a/b")).is_err());
    }
}
