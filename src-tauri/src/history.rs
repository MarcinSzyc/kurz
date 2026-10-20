//! Past cleanups, kept in a small JSON file so they can be restored and shown in History.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cleanup::Mode;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub original: String,
    /// Where it is in the Trash; `None` when deleted permanently.
    pub trashed: Option<String>,
    pub restored: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedItem {
    pub label: String,
    pub size: u64,
    pub paths: Vec<Removed>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub id: String,
    /// Unix seconds.
    pub at: i64,
    pub mode: Mode,
    pub items: Vec<CleanedItem>,
}

impl Cleanup {
    pub fn freed(&self) -> u64 {
        self.items.iter().map(|i| i.size).sum()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct History {
    /// Newest last.
    pub cleanups: Vec<Cleanup>,
}

pub fn load(path: &Path) -> History {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn save(path: &Path, history: &History) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(history).map_err(io::Error::other)?)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_sums_what_was_freed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("history.json");
        let removed = |p: &str| Removed { original: p.into(), trashed: Some(format!("/Users/me/.Trash/{p}")), restored: false };
        let history = History {
            cleanups: vec![Cleanup {
                id: "1".into(),
                at: 1_800_000_000,
                mode: Mode::Trash,
                items: vec![
                    CleanedItem { label: "npm cache".into(), size: 3, paths: vec![removed("a")] },
                    CleanedItem { label: "Logs".into(), size: 2, paths: vec![removed("b")] },
                ],
            }],
        };

        save(&path, &history).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded, history);
        assert_eq!(loaded.cleanups[0].freed(), 5);
        assert_eq!(load(&tmp.path().join("missing.json")), History::default());
    }
}
