//! Cleanup rules: what Kurz may recommend removing, how risky it is, and what it never touches.
//!
//! This list is the single source of truth: the "How it works" screen renders it as is.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Risk {
    /// Regenerated automatically and holds no user data.
    Safe,
    /// Can be restored, but at a cost (re-download, reinstall), or may still be wanted.
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matcher {
    /// A fixed path relative to the home folder.
    Path(&'static str),
    /// A folder with this name anywhere, next to one of these files.
    NameNextTo(&'static str, &'static [&'static str]),
    /// Files directly in this folder (relative to home) unchanged for this many days.
    OldFilesIn(&'static str, u32),
}

impl Matcher {
    pub fn describe(&self) -> String {
        match self {
            Matcher::Path(path) => format!("~/{path}"),
            Matcher::NameNextTo(name, files) => format!("{name} next to {}", files.join(" or ")),
            Matcher::OldFilesIn(dir, days) => format!("Files in ~/{dir} unchanged for {days}+ days"),
        }
    }
}

#[derive(Debug)]
pub struct Rule {
    pub id: &'static str,
    pub label: &'static str,
    pub risk: Risk,
    pub matcher: Matcher,
    /// Only recommend when the project around the match is idle (see `IDLE_DAYS`).
    pub needs_idle_project: bool,
    /// Why it's taking space and why removing it is fine.
    pub reason: &'static str,
    /// What happens after removal / how to get it back.
    pub restore: &'static str,
    /// The tool's own cleanup command, used in the copied script when available.
    pub command: Option<&'static str>,
}

/// A project counts as idle when nothing in it changed for this many days.
pub const IDLE_DAYS: u32 = 30;

const JS_PROJECT: &[&str] = &["package.json"];

pub const RULES: &[Rule] = &[
    // Safe: caches and build output that tools recreate on their own.
    Rule {
        id: "npm-cache",
        label: "npm cache",
        risk: Risk::Safe,
        matcher: Matcher::Path(".npm/_cacache"),
        needs_idle_project: false,
        reason: "Copies of every package npm has downloaded.",
        restore: "npm downloads packages again when they're next installed.",
        command: Some("npm cache clean --force"),
    },
    Rule {
        id: "pnpm-store",
        label: "pnpm store",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/pnpm/store"),
        needs_idle_project: false,
        reason: "Shared package store for every pnpm project.",
        restore: "pnpm refills it on the next install.",
        command: Some("pnpm store prune"),
    },
    Rule {
        id: "yarn-cache",
        label: "Yarn cache",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Caches/Yarn"),
        needs_idle_project: false,
        reason: "Downloaded Yarn packages.",
        restore: "Yarn downloads packages again when needed.",
        command: Some("yarn cache clean"),
    },
    Rule {
        id: "gradle-cache",
        label: "Gradle caches",
        risk: Risk::Safe,
        matcher: Matcher::Path(".gradle/caches"),
        needs_idle_project: false,
        reason: "Downloaded dependencies and build caches of Gradle (Android, Java, Kotlin).",
        restore: "The next Gradle build downloads what it needs.",
        command: None,
    },
    Rule {
        id: "uv-cache",
        label: "uv cache",
        risk: Risk::Safe,
        matcher: Matcher::Path(".cache/uv"),
        needs_idle_project: false,
        reason: "Python packages downloaded by uv.",
        restore: "uv downloads packages again when needed.",
        command: Some("uv cache clean"),
    },
    Rule {
        id: "pip-cache",
        label: "pip cache",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Caches/pip"),
        needs_idle_project: false,
        reason: "Python packages downloaded by pip.",
        restore: "pip downloads packages again when needed.",
        command: Some("pip cache purge"),
    },
    Rule {
        id: "puppeteer-cache",
        label: "Puppeteer browsers",
        risk: Risk::Safe,
        matcher: Matcher::Path(".cache/puppeteer"),
        needs_idle_project: false,
        reason: "Browser builds downloaded for Puppeteer.",
        restore: "Puppeteer downloads a browser again on the next install.",
        command: None,
    },
    Rule {
        id: "homebrew-cache",
        label: "Homebrew downloads",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Caches/Homebrew"),
        needs_idle_project: false,
        reason: "Installers Homebrew keeps after installing.",
        restore: "Homebrew downloads them again if it needs to reinstall.",
        command: Some("brew cleanup -s"),
    },
    Rule {
        id: "xcode-derived-data",
        label: "Xcode DerivedData",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Developer/Xcode/DerivedData"),
        needs_idle_project: false,
        reason: "Intermediate build files and indexes of Xcode projects.",
        restore: "Xcode rebuilds them; the next build and indexing take longer.",
        command: None,
    },
    Rule {
        id: "next-build",
        label: "Next.js build output",
        risk: Risk::Safe,
        matcher: Matcher::NameNextTo(".next", JS_PROJECT),
        needs_idle_project: false,
        reason: "Build output and cache of a Next.js app.",
        restore: "Recreated by the next `next dev` or `next build`.",
        command: None,
    },
    Rule {
        id: "turbo-cache",
        label: "Turborepo cache",
        risk: Risk::Safe,
        matcher: Matcher::NameNextTo(".turbo", JS_PROJECT),
        needs_idle_project: false,
        reason: "Local task cache of Turborepo.",
        restore: "Tasks run in full once, then are cached again.",
        command: None,
    },
    Rule {
        id: "cargo-target",
        label: "Rust build output",
        risk: Risk::Safe,
        matcher: Matcher::NameNextTo("target", &["Cargo.toml"]),
        needs_idle_project: false,
        reason: "Compiled artifacts of a Rust project.",
        restore: "Recreated by the next `cargo build`.",
        command: Some("cargo clean"),
    },
    // Review: restorable, but costly or possibly still in use.
    Rule {
        id: "idle-node-modules",
        label: "node_modules in idle projects",
        risk: Risk::Review,
        matcher: Matcher::NameNextTo("node_modules", JS_PROJECT),
        needs_idle_project: true,
        reason: "Installed dependencies of JavaScript projects you haven't touched lately.",
        restore: "Run your package manager's install (npm/pnpm/yarn install) in the project.",
        command: None,
    },
    Rule {
        id: "ollama-models",
        label: "Ollama models",
        risk: Risk::Review,
        matcher: Matcher::Path(".ollama/models"),
        needs_idle_project: false,
        reason: "Local AI models, often several GB each.",
        restore: "Download again with `ollama pull <model>`.",
        command: Some("ollama rm <model>"),
    },
    Rule {
        id: "android-system-images",
        label: "Android emulator images",
        risk: Risk::Review,
        matcher: Matcher::Path("Library/Android/sdk/system-images"),
        needs_idle_project: false,
        reason: "System images used to create Android emulators.",
        restore: "Download again from Android Studio's SDK Manager.",
        command: None,
    },
    Rule {
        id: "android-avds",
        label: "Android emulators",
        risk: Risk::Review,
        matcher: Matcher::Path(".android/avd"),
        needs_idle_project: false,
        reason: "Virtual devices with their disks and snapshots.",
        restore: "Create them again in Android Studio's Device Manager; their data is lost.",
        command: None,
    },
    Rule {
        id: "ios-device-support",
        label: "iOS DeviceSupport",
        risk: Risk::Review,
        matcher: Matcher::Path("Library/Developer/Xcode/iOS DeviceSupport"),
        needs_idle_project: false,
        reason: "Debug symbols Xcode copies from every iOS version you've connected.",
        restore: "Xcode copies them again when you connect a device.",
        command: None,
    },
    Rule {
        id: "ios-simulators",
        label: "iOS simulators",
        risk: Risk::Review,
        matcher: Matcher::Path("Library/Developer/CoreSimulator/Devices"),
        needs_idle_project: false,
        reason: "Simulator devices with installed apps and their data.",
        restore: "Xcode recreates simulators; apps and data on them are lost.",
        command: Some("xcrun simctl delete unavailable"),
    },
    Rule {
        id: "app-caches",
        label: "Other app caches",
        risk: Risk::Review,
        matcher: Matcher::Path("Library/Caches"),
        needs_idle_project: false,
        reason: "Caches of apps, rebuilt as they're used.",
        restore: "Apps rebuild caches; quit them first, as an open app may misbehave.",
        command: None,
    },
    Rule {
        id: "old-downloads",
        label: "Old downloads",
        risk: Risk::Review,
        matcher: Matcher::OldFilesIn("Downloads", 90),
        needs_idle_project: false,
        reason: "Files sitting in Downloads for months, often installers and archives.",
        restore: "Restore from the Trash, or download again.",
        command: None,
    },
];

/// Never recommended, never removed, even if a rule were to match inside them.
pub const NEVER: &[(&str, &str)] = &[
    ("Documents", "Your documents"),
    ("Desktop", "Your desktop"),
    ("Pictures", "Photos library and pictures"),
    ("Movies", "Your videos"),
    ("Music", "Your music"),
    ("Library/Mobile Documents", "iCloud Drive"),
    ("Library/Mail", "Mail"),
    ("Library/Messages", "Messages"),
    ("Library/Keychains", "Passwords and certificates"),
    (".ssh", "SSH keys"),
    (".gnupg", "GPG keys"),
];

/// True when `relative` (a path relative to home) is inside a protected location.
// Used by cleanup, which lands next; the rule tests already cover it.
#[allow(dead_code)]
pub fn is_protected(relative: &str) -> bool {
    NEVER.iter().any(|(path, _)| relative == *path || relative.starts_with(&format!("{path}/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique() {
        let ids: HashSet<_> = RULES.iter().map(|r| r.id).collect();
        assert_eq!(ids.len(), RULES.len());
    }

    #[test]
    fn no_rule_points_into_a_protected_location() {
        for rule in RULES {
            let path = match rule.matcher {
                Matcher::Path(p) | Matcher::OldFilesIn(p, _) => p,
                Matcher::NameNextTo(..) => continue,
            };
            assert!(!path.starts_with('/') && !path.contains(".."), "{} must be relative to home", rule.id);
            assert!(!is_protected(path), "{} points into a protected location", rule.id);
        }
    }

    #[test]
    fn protects_nested_paths_only() {
        assert!(is_protected("Documents"));
        assert!(is_protected("Documents/taxes.pdf"));
        assert!(is_protected("Library/Mail/V10"));
        assert!(!is_protected("Documentsy"));
        assert!(!is_protected("Library/Caches"));
    }
}
