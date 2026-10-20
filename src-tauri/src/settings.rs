//! User settings, stored as a small JSON file in the app's config folder.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gauge::Style;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MenuBarText {
    /// "62%"
    PercentUsed,
    /// "382/994 GB"
    UsedOfTotal,
    /// "612 GB"
    Free,
    /// Gauge only.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuBarSettings {
    pub enabled: bool,
    pub icon: Style,
    pub text: MenuBarText,
    /// Percent of the disk used at which the icon turns amber.
    pub warn_at: u8,
    /// Percent of the disk used at which the icon turns coral.
    pub critical_at: u8,
    pub refresh_minutes: u32,
}

impl Default for MenuBarSettings {
    fn default() -> Self {
        Self { enabled: true, icon: Style::Tank, text: MenuBarText::Free, warn_at: 80, critical_at: 95, refresh_minutes: 5 }
    }
}

impl MenuBarSettings {
    /// Keeps values in range and the critical threshold above the warning one.
    pub fn sanitized(mut self) -> Self {
        self.warn_at = self.warn_at.clamp(1, 98);
        self.critical_at = self.critical_at.clamp(self.warn_at + 1, 99);
        self.refresh_minutes = self.refresh_minutes.clamp(1, 24 * 60);
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub menu_bar: MenuBarSettings,
}

/// Reads settings, falling back to defaults when the file is missing or unreadable.
pub fn load(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .map(|s| Settings { menu_bar: s.menu_bar.sanitized() })
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(io::Error::other)?;
    // Write then rename, so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(&tmp.path().join("nope.json")), Settings::default());
    }

    #[test]
    fn round_trips_through_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested/settings.json");
        let mut settings = Settings::default();
        settings.menu_bar.text = MenuBarText::Free;
        settings.menu_bar.warn_at = 70;

        save(&path, &settings).unwrap();

        assert_eq!(load(&path), settings);
    }

    #[test]
    fn fills_in_missing_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        fs::write(&path, r#"{"menuBar":{"warnAt":75}}"#).unwrap();

        let menu_bar = load(&path).menu_bar;

        assert_eq!(menu_bar.warn_at, 75);
        assert_eq!(menu_bar.critical_at, 95);
        assert!(menu_bar.enabled);
    }

    #[test]
    fn keeps_critical_above_warning() {
        let s = MenuBarSettings { warn_at: 95, critical_at: 90, refresh_minutes: 0, ..Default::default() }.sanitized();
        assert_eq!((s.warn_at, s.critical_at, s.refresh_minutes), (95, 96, 1));
    }
}
