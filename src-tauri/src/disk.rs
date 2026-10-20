//! Capacity of the volume a path lives on.

use std::ffi::{CStr, CString};
use std::fs;
use std::io;
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    /// Name shown in Finder, e.g. "Macintosh HD".
    pub name: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total: u64,
    /// Space available to the user (excludes space reserved by the system).
    pub available: u64,
    pub used: u64,
}

pub fn disk_info(path: &Path) -> io::Result<DiskInfo> {
    let c_path = CString::new(path.as_os_str().as_bytes())?;
    let mut stat = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: c_path is a valid NUL-terminated string and stat is written by statfs on success.
    if unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs returned 0, so the struct is initialized.
    let stat = unsafe { stat.assume_init() };

    let block = stat.f_bsize as u64;
    let total = stat.f_blocks * block;
    let available = stat.f_bavail * block;
    // SAFETY: both fields are NUL-terminated C strings filled in by statfs.
    let mount_point = unsafe { CStr::from_ptr(stat.f_mntonname.as_ptr()) }.to_string_lossy().into_owned();
    let fs_type = unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }.to_string_lossy().into_owned();

    Ok(DiskInfo {
        name: volume_name(&mount_point),
        mount_point,
        fs_type,
        total,
        available,
        used: total.saturating_sub(available),
    })
}

/// Finder's name for a mount point: the entry in /Volumes that points at it.
/// The startup disk's data volume is mounted separately from "/", so it maps to "/" as well.
fn volume_name(mount_point: &str) -> String {
    let target = match mount_point {
        "/System/Volumes/Data" => PathBuf::from("/"),
        other => PathBuf::from(other),
    };
    fs::read_dir("/Volumes")
        .into_iter()
        .flatten()
        .flatten()
        .find(|entry| fs::canonicalize(entry.path()).is_ok_and(|p| p == target))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .unwrap_or_else(|| mount_point.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_volume_of_a_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let info = disk_info(tmp.path()).unwrap();
        assert!(info.total > 0);
        assert!(info.available <= info.total);
        assert_eq!(info.used, info.total - info.available);
        assert!(!info.name.is_empty());
    }
}
