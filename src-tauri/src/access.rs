//! Full Disk Access: whether Kurz has it, and opening the right System Settings pane.

use std::fs::File;
use std::io;
use std::path::Path;
use std::process::Command;

/// macOS lets only apps with Full Disk Access open this file. Kurz opens it to find out,
/// and never reads or changes it.
const PROBE: &str = "Library/Application Support/com.apple.TCC/TCC.db";

const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

pub fn has_full_disk_access(home: &Path) -> bool {
    File::open(home.join(PROBE)).is_ok()
}

/// Opens System Settings at Privacy & Security → Full Disk Access.
pub fn open_settings() -> io::Result<()> {
    let status = Command::new("/usr/bin/open").arg(SETTINGS_URL).status()?;
    if status.success() { Ok(()) } else { Err(io::Error::other(format!("open exited with {status}"))) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_no_when_the_probe_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!has_full_disk_access(tmp.path()));
    }
}
