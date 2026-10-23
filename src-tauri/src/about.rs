//! "What is this?" for recommendations: which app a folder belongs to, read locally from macOS,
//! plus short notes for folders whose names say little. Nothing is looked up online.

use std::path::Path;

use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSFileManager, NSString};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    /// The app's name, or its bundle id when it isn't installed.
    pub name: String,
    pub installed: bool,
    pub running: bool,
}

/// Folders in ~/Library/Caches that need explaining: (folder name, owner bundle id, label, what it is).
const KNOWN_CACHES: &[(&str, Option<&str>, &str, &str)] = &[
    (
        "Google",
        Some("com.google.Chrome"),
        "Google cache",
        "Caches of Google apps, mostly Chrome: pages and images saved so they load faster.",
    ),
    (
        "Firefox",
        Some("org.mozilla.firefox"),
        "Firefox cache",
        "Firefox's web cache: saved pages and images. Bookmarks, history and passwords are kept elsewhere.",
    ),
    (
        "typescript",
        None,
        "TypeScript cache",
        "Type definitions your editor's TypeScript server (VS Code, Cursor) downloaded. Fetched again on demand.",
    ),
    ("pnpm", None, "pnpm metadata", "pnpm's cache of package metadata. The packages themselves are in the pnpm store."),
    ("node-gyp", None, "node-gyp headers", "Node.js headers downloaded to compile native npm modules. Downloaded again when needed."),
    ("CocoaPods", None, "CocoaPods cache", "Pods downloaded for iOS projects. pod install fetches them again."),
    ("SiriTTS", None, "Siri voices", "Voices downloaded for Siri and spoken content. macOS downloads them again when needed."),
    (
        "com.spotify.client",
        Some("com.spotify.client"),
        "Spotify cache",
        "Songs Spotify streamed recently, and artwork. Offline playlists download again.",
    ),
    (
        "com.tinyspeck.slackmacgap",
        Some("com.tinyspeck.slackmacgap"),
        "Slack cache",
        "Images and files Slack saved from your workspaces. Slack downloads them again as you scroll.",
    ),
];

/// Apps behind some rules, so a row can say "Quit Docker first".
const RULE_OWNERS: &[(&str, &str)] = &[
    ("docker-data", "com.docker.docker"),
    ("xcode-derived-data", "com.apple.dt.Xcode"),
    ("ios-device-support", "com.apple.dt.Xcode"),
    ("ios-simulators", "com.apple.iphonesimulator"),
];

/// Finds an installed app by bundle id, anywhere macOS knows about (not just /Applications).
pub(crate) fn app_name(bundle_id: &str) -> Option<String> {
    let url = NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
    let path = url.path()?;
    let name = NSFileManager::defaultManager().displayNameAtPath(&path).to_string();
    Some(name.trim_end_matches(".app").to_string())
}

/// Asks every running instance of an app to quit, as if from its menu (it may still ask to save).
pub(crate) fn ask_to_quit(bundle_id: &str) {
    for app in NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id)).iter() {
        app.terminate();
    }
}

pub(crate) fn is_running(bundle_id: &str) -> bool {
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id)).count() > 0
}

fn owner(bundle_id: &str) -> Owner {
    match app_name(bundle_id) {
        Some(name) => Owner { name, installed: true, running: is_running(bundle_id) },
        None => Owner { name: bundle_id.to_string(), installed: false, running: false },
    }
}

/// A folder named like `com.vendor.App`, i.e. probably an app's bundle id.
pub(crate) fn looks_like_bundle_id(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() >= 3 && matches!(parts[0], "com" | "org" | "net" | "io" | "dev" | "app" | "co" | "de" | "us" | "me")
}

pub struct About {
    /// A clearer name for the row, when Kurz knows one.
    pub label: Option<String>,
    pub what: String,
    /// What kind of thing it is, for the "What it is" column.
    pub kind: &'static str,
    /// What happens after removal, when it differs from the rule's.
    pub after: Option<String>,
    pub owner: Option<Owner>,
}

/// The "What it is" column for each rule; app caches are told apart from updater leftovers.
fn kind_of(rule_id: &str) -> &'static str {
    match rule_id {
        "npm-cache"
        | "pnpm-store"
        | "yarn-cache"
        | "gradle-cache"
        | "uv-cache"
        | "pip-cache"
        | "puppeteer-cache"
        | "homebrew-cache"
        | "playwright-browsers" => "Package cache",
        "xcode-derived-data" | "idle-node-modules" | "next-build" | "turbo-cache" | "cargo-target" => "Build output",
        "docker-data" => "Container data",
        "android-avds" | "ios-simulators" => "Emulator",
        "android-system-images" | "ios-device-support" => "SDK",
        "ollama-models" => "AI models",
        "logs" => "Logs",
        "idle-projects" => "Project",
        "old-downloads" => "Your files",
        _ => "App cache",
    }
}

/// Explains one item of a rule. `path` is the item's folder when it is a single one.
pub fn describe(rule_id: &str, reason: &str, path: Option<&Path>) -> About {
    if rule_id == "app-caches"
        && let Some(name) = path.and_then(|p| p.file_name()).and_then(|n| n.to_str())
    {
        return describe_cache(name);
    }
    let owner = RULE_OWNERS.iter().find(|(id, _)| *id == rule_id).map(|(_, bundle)| owner(bundle)).filter(|o| o.installed);
    About { label: None, what: reason.to_string(), kind: kind_of(rule_id), after: None, owner }
}

fn describe_cache(folder: &str) -> About {
    if let Some((_, bundle, label, what)) = KNOWN_CACHES.iter().find(|(name, ..)| *name == folder) {
        return About {
            label: Some(label.to_string()),
            what: what.to_string(),
            kind: "App cache",
            after: None,
            owner: bundle.map(owner).filter(|o| o.installed),
        };
    }
    // Squirrel, the updater many Electron apps use, leaves downloads in <bundle id>.ShipIt.
    if let Some(bundle) = folder.strip_suffix(".ShipIt") {
        let o = owner(bundle);
        let app = if o.installed { o.name.clone() } else { bundle.to_string() };
        return About {
            label: Some(format!("{app} update files")),
            what: format!("Updates {app} downloaded through its updater. Installed ones are leftovers."),
            kind: "Update files",
            after: Some("A pending update downloads again.".to_string()),
            owner: Some(o),
        };
    }
    if looks_like_bundle_id(folder) {
        let o = owner(folder);
        return if o.installed {
            About {
                label: Some(format!("{} cache", o.name)),
                what: format!("Files {} saved so it loads faster. It recreates them as needed.", o.name),
                kind: "App cache",
                after: None,
                owner: Some(o),
            }
        } else {
            About {
                label: None,
                what: "Cache of an app that isn't installed anymore: a leftover, safe to remove.".to_string(),
                kind: "App cache",
                after: Some("Nothing uses it anymore.".to_string()),
                owner: Some(o),
            }
        };
    }
    About {
        label: None,
        what: "An app's cache folder. Apps recreate their caches as they're used.".to_string(),
        kind: "App cache",
        after: None,
        owner: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_bundle_id_names() {
        assert!(looks_like_bundle_id("com.tinyapp.TablePlus"));
        assert!(looks_like_bundle_id("org.mozilla.firefox"));
        assert!(!looks_like_bundle_id("Firefox"));
        assert!(!looks_like_bundle_id("com.apple"));
    }

    #[test]
    fn explains_known_folders_without_any_app() {
        let about = describe_cache("typescript");
        assert_eq!(about.label.as_deref(), Some("TypeScript cache"));
        assert!(about.owner.is_none());
    }

    #[test]
    fn names_updater_leftovers() {
        let about = describe_cache("com.example.never-installed.ShipIt");
        assert_eq!(about.label.as_deref(), Some("com.example.never-installed update files"));
        assert_eq!(about.kind, "Update files");
        assert_eq!(about.owner.map(|o| o.installed), Some(false));
    }

    #[test]
    fn flags_caches_of_apps_that_are_gone() {
        let about = describe_cache("com.example.kurz-test-missing-app");
        let owner = about.owner.unwrap();
        assert!(!owner.installed && !owner.running);
        assert!(about.what.contains("isn't installed"));
    }

    #[test]
    fn finds_apps_that_ship_with_macos() {
        // Finder is always there, wherever macOS keeps it.
        let o = owner("com.apple.finder");
        assert!(o.installed, "{o:?}");
        // CI machines may have no logged-in desktop, so no Finder running.
        if std::env::var_os("CI").is_none() {
            assert!(o.running, "Finder is always running");
        }
    }

    #[test]
    fn keeps_rule_reasons_for_other_items() {
        let about = describe("npm-cache", "Copies of every package npm has downloaded.", None);
        assert_eq!(about.what, "Copies of every package npm has downloaded.");
        assert!(about.label.is_none() && about.owner.is_none());
    }
}
