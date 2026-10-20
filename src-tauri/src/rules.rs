//! Cleanup rules: what Kurz may recommend removing, how risky it is, and what it never touches.
//!
//! This list is the single source of truth: the "How it works" screen renders it as is.

use serde::Serialize;

use crate::categories::Category;

/// Ordered from safest to riskiest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Risk {
    /// Caches and leftovers that apps recreate on their own.
    Safe,
    /// Dependencies, SDKs, emulators and build output: reinstalling or rebuilding brings them back.
    Rebuildable,
    /// May hold your own data or projects; check before removing.
    TakeALook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matcher {
    /// A fixed path relative to the home folder.
    Path(&'static str),
    /// A folder with this name anywhere, next to one of these files.
    NameNextTo(&'static str, &'static [&'static str]),
    /// Files directly in this folder (relative to home) unchanged for this many days.
    OldFilesIn(&'static str, u32),
    /// Each folder inside this one (relative to home), as its own item.
    EachChildOf(&'static str),
    /// Git repositories (a folder containing .git) unchanged for this many days.
    IdleRepository(u32),
}

impl Matcher {
    pub fn describe(&self) -> String {
        match self {
            Matcher::Path(path) => format!("~/{path}"),
            Matcher::NameNextTo(name, files) => format!("{name} next to {}", files.join(" or ")),
            Matcher::OldFilesIn(dir, days) => {
                format!("Files in ~/{dir} unchanged for {days}+ days")
            }
            Matcher::EachChildOf(dir) => format!("Each folder in ~/{dir}"),
            Matcher::IdleRepository(days) => format!("Git repositories unchanged for {days}+ days"),
        }
    }
}

#[derive(Debug)]
pub struct Rule {
    pub id: &'static str,
    pub label: &'static str,
    pub risk: Risk,
    /// Category of what it removes, for the color next to it.
    pub category: Category,
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
/// A repository is offered for removal itself only after much longer.
pub const IDLE_REPO_DAYS: u32 = 365;
/// Matches smaller than this aren't worth a row.
pub const MIN_ITEM_SIZE: u64 = 50_000_000;

const JS_PROJECT: &[&str] = &["package.json"];

pub const RULES: &[Rule] = &[
    // Safe to delete: caches and leftovers that tools recreate on their own.
    Rule {
        id: "npm-cache",
        category: Category::Cache,
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
        category: Category::Cache,
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
        category: Category::Cache,
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
        category: Category::Cache,
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
        category: Category::Cache,
        label: "uv package archive",
        risk: Risk::Safe,
        matcher: Matcher::Path(".cache/uv"),
        needs_idle_project: false,
        reason: "Python packages downloaded by uv.",
        restore: "uv downloads packages again when needed.",
        command: Some("uv cache clean"),
    },
    Rule {
        id: "pip-cache",
        category: Category::Cache,
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
        category: Category::Cache,
        label: "Puppeteer Chromium",
        risk: Risk::Safe,
        matcher: Matcher::Path(".cache/puppeteer"),
        needs_idle_project: false,
        reason: "Browser builds downloaded for Puppeteer.",
        restore: "Puppeteer downloads a browser again on the next install.",
        command: None,
    },
    Rule {
        id: "homebrew-cache",
        category: Category::Cache,
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
        category: Category::Cache,
        label: "Xcode DerivedData",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Developer/Xcode/DerivedData"),
        needs_idle_project: false,
        reason: "Intermediate build files and indexes of Xcode projects.",
        restore: "Xcode rebuilds them; the next build and indexing take longer.",
        command: None,
    },
    Rule {
        id: "logs",
        category: Category::System,
        label: "Logs",
        risk: Risk::Safe,
        matcher: Matcher::Path("Library/Logs"),
        needs_idle_project: false,
        reason: "Diagnostic logs written by apps and macOS.",
        restore: "Apps start new logs as they run.",
        command: None,
    },
    // Rebuildable: reinstalling or rebuilding brings them back, at the cost of time or a download.
    Rule {
        id: "playwright-browsers",
        category: Category::Cache,
        label: "Playwright browsers",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path("Library/Caches/ms-playwright"),
        needs_idle_project: false,
        reason: "Browsers downloaded for Playwright tests.",
        restore: "Run `npx playwright install` to download them again.",
        command: None,
    },
    Rule {
        id: "idle-node-modules",
        category: Category::Cache,
        label: "node_modules",
        risk: Risk::Rebuildable,
        matcher: Matcher::NameNextTo("node_modules", JS_PROJECT),
        needs_idle_project: true,
        reason: "Installed dependencies of JavaScript projects you haven't touched lately.",
        restore: "Run your package manager's install (npm/pnpm/yarn install) in the project.",
        command: None,
    },
    Rule {
        id: "next-build",
        category: Category::Cache,
        label: ".next build output",
        risk: Risk::Rebuildable,
        matcher: Matcher::NameNextTo(".next", JS_PROJECT),
        needs_idle_project: false,
        reason: "Build output and cache of a Next.js app.",
        restore: "Recreated by the next `next dev` or `next build`.",
        command: None,
    },
    Rule {
        id: "turbo-cache",
        category: Category::Cache,
        label: "Turborepo cache",
        risk: Risk::Rebuildable,
        matcher: Matcher::NameNextTo(".turbo", JS_PROJECT),
        needs_idle_project: false,
        reason: "Local task cache of Turborepo.",
        restore: "Tasks run in full once, then are cached again.",
        command: None,
    },
    Rule {
        id: "cargo-target",
        category: Category::Cache,
        label: "Rust build output",
        risk: Risk::Rebuildable,
        matcher: Matcher::NameNextTo("target", &["Cargo.toml"]),
        needs_idle_project: false,
        reason: "Compiled artifacts of a Rust project.",
        restore: "Recreated by the next `cargo build`.",
        command: Some("cargo clean"),
    },
    Rule {
        id: "docker-data",
        category: Category::System,
        label: "Docker data",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path("Library/Containers/com.docker.docker"),
        needs_idle_project: false,
        reason: "Docker's disk image with all images, containers and volumes.",
        restore: "Pull or build images again; volumes and their data are lost.",
        command: Some("docker system prune -a --volumes"),
    },
    Rule {
        id: "android-system-images",
        category: Category::Sdk,
        label: "Android emulator images",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path("Library/Android/sdk/system-images"),
        needs_idle_project: false,
        reason: "System images used to create Android emulators.",
        restore: "Download again from Android Studio's SDK Manager.",
        command: None,
    },
    Rule {
        id: "android-avds",
        category: Category::Sdk,
        label: "Android emulators",
        risk: Risk::Rebuildable,
        matcher: Matcher::EachChildOf(".android/avd"),
        needs_idle_project: false,
        reason: "Virtual devices with their disks and snapshots.",
        restore: "Create them again in Android Studio's Device Manager; their data is lost.",
        command: None,
    },
    Rule {
        id: "ios-device-support",
        category: Category::Sdk,
        label: "iOS DeviceSupport",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path("Library/Developer/Xcode/iOS DeviceSupport"),
        needs_idle_project: false,
        reason: "Debug symbols Xcode copies from every iOS version you've connected.",
        restore: "Xcode copies them again when you connect a device.",
        command: None,
    },
    Rule {
        id: "ios-simulators",
        category: Category::Sdk,
        label: "iOS simulators",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path("Library/Developer/CoreSimulator/Devices"),
        needs_idle_project: false,
        reason: "Simulator devices with installed apps and their data.",
        restore: "Xcode recreates simulators; apps and data on them are lost.",
        command: Some("xcrun simctl delete unavailable"),
    },
    Rule {
        id: "ollama-models",
        category: Category::AiModels,
        label: "Ollama models",
        risk: Risk::Rebuildable,
        matcher: Matcher::Path(".ollama/models"),
        needs_idle_project: false,
        reason: "Local AI models, often several GB each.",
        restore: "Download again with `ollama pull <model>`.",
        command: Some("ollama rm <model>"),
    },
    // Last among caches, so the specific cache rules above claim their folders first.
    Rule {
        id: "app-caches",
        category: Category::Cache,
        label: "cache",
        risk: Risk::Safe,
        matcher: Matcher::EachChildOf("Library/Caches"),
        needs_idle_project: false,
        reason: "An app's cache, rebuilt as the app is used.",
        restore: "The app rebuilds it; quit the app first, as an open app may misbehave.",
        command: None,
    },
    // Take a look: may hold your own data or projects.
    Rule {
        id: "idle-projects",
        category: Category::Code,
        label: "Idle projects",
        risk: Risk::TakeALook,
        matcher: Matcher::IdleRepository(IDLE_REPO_DAYS),
        needs_idle_project: false,
        reason: "Git repositories you haven't changed in a long time.",
        restore: "Clone it again if it's on a remote; local-only changes are lost.",
        command: None,
    },
    Rule {
        id: "old-downloads",
        category: Category::Media,
        label: "Old downloads",
        risk: Risk::TakeALook,
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
                Matcher::Path(p) | Matcher::OldFilesIn(p, _) | Matcher::EachChildOf(p) => p,
                Matcher::NameNextTo(..) | Matcher::IdleRepository(_) => continue,
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
