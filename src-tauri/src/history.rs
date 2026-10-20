//! Past cleanups, kept in a small JSON file so they can be restored and shown in History.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::cleanup::Mode;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub original: String,
    /// Where it is in the Trash; `None` when deleted permanently.
    pub trashed: Option<String>,
    pub restored: bool,
    /// Whether it's still in the Trash; filled in when the history is read.
    #[serde(default)]
    pub in_trash: bool,
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

/// Free space at a moment, for the History chart.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub at: i64,
    pub free: u64,
}

/// Sizes of one recommendation across scans, to spot folders that keep growing back.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Growth {
    pub label: String,
    pub location: String,
    /// (Unix seconds, bytes), oldest first, at most one per day.
    pub sizes: Vec<(i64, u64)>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct History {
    /// Newest last.
    pub cleanups: Vec<Cleanup>,
    /// Oldest first, at most one per `SAMPLE_EVERY`.
    pub samples: Vec<Sample>,
    /// By recommendation id.
    pub growth: BTreeMap<String, Growth>,
}

const DAY: i64 = 86_400;
const SAMPLE_EVERY: i64 = 3_600;
/// Samples and sizes older than this are dropped.
const KEEP: i64 = 120 * DAY;

/// Serializes every read-modify-write of the history file across threads.
static LOCK: Mutex<()> = Mutex::new(());

/// Loads, changes and saves the history under one lock.
pub fn update<T>(path: &Path, change: impl FnOnce(&mut History) -> T) -> io::Result<T> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut history = load(path);
    let out = change(&mut history);
    save(path, &history)?;
    Ok(out)
}

impl History {
    /// Records free space, unless the last sample is under an hour old (`force` records anyway,
    /// e.g. right after a cleanup).
    pub fn sample(&mut self, at: i64, free: u64, force: bool) {
        if !force && self.samples.last().is_some_and(|s| at - s.at < SAMPLE_EVERY) {
            return;
        }
        self.samples.push(Sample { at, free });
        self.samples.retain(|s| s.at > at - KEEP);
    }

    /// Records today's size of each recommendation, replacing an earlier record from the same day.
    pub fn record_sizes<'a>(&mut self, at: i64, items: impl IntoIterator<Item = (&'a str, &'a str, &'a str, u64)>) {
        for (id, label, location, size) in items {
            let growth = self.growth.entry(id.to_string()).or_default();
            growth.label = label.to_string();
            growth.location = location.to_string();
            if growth.sizes.last().is_some_and(|(t, _)| t / DAY == at / DAY) {
                growth.sizes.pop();
            }
            growth.sizes.push((at, size));
            growth.sizes.retain(|(t, _)| *t > at - KEEP);
        }
        self.growth.retain(|_, g| !g.sizes.is_empty());
    }
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
        let removed =
            |p: &str| Removed { original: p.into(), trashed: Some(format!("/Users/me/.Trash/{p}")), restored: false, in_trash: false };
        let history = History {
            samples: vec![],
            growth: BTreeMap::new(),
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

    #[test]
    fn samples_at_most_hourly_unless_forced() {
        let mut h = History::default();
        h.sample(1_000_000, 10, false);
        h.sample(1_000_000 + 600, 11, false);
        h.sample(1_000_000 + 700, 12, true);
        h.sample(1_000_000 + 700 + 3_600, 13, false);
        assert_eq!(h.samples.iter().map(|s| s.free).collect::<Vec<_>>(), vec![10, 12, 13]);
    }

    #[test]
    fn keeps_one_size_per_day_and_drops_old_ones() {
        let mut h = History::default();
        let day = |d: i64| 1_800_000_000 + d * DAY;
        h.record_sizes(day(0), [("npm", "npm cache", "~/.npm", 1)]);
        h.record_sizes(day(0) + 60, [("npm", "npm cache", "~/.npm", 2)]);
        h.record_sizes(day(1), [("npm", "npm cache", "~/.npm", 3)]);
        assert_eq!(h.growth["npm"].sizes, vec![(day(0) + 60, 2), (day(1), 3)]);

        h.record_sizes(day(200), [("npm", "npm cache", "~/.npm", 4)]);
        assert_eq!(h.growth["npm"].sizes, vec![(day(200), 4)]);
    }

    #[test]
    fn updates_under_the_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("history.json");
        update(&path, |h| h.sample(5, 50, true)).unwrap();
        update(&path, |h| h.sample(10, 40, true)).unwrap();
        assert_eq!(load(&path).samples.len(), 2);
    }
}
