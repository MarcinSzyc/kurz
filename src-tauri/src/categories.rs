//! Sorts folders into broad categories, used to color the map.

use serde::Serialize;

use crate::scanner::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    /// Documents, pictures, music, downloads.
    Media,
    /// Git repositories and what's inside them.
    Code,
    /// Editors, language toolchains and CLI tools.
    DevTools,
    /// Android SDK, Xcode and simulators.
    Sdk,
    /// Local AI models.
    AiModels,
    /// Package manager caches and build output, safe to regenerate.
    Cache,
    /// Application data in ~/Library and apps.
    System,
    Other,
}

const MEDIA: &[&str] = &["Documents", "Pictures", "Movies", "Music", "Desktop", "Downloads", "Public"];
const CACHE: &[&str] = &[
    "node_modules",
    ".next",
    ".turbo",
    ".nuxt",
    ".parcel-cache",
    ".npm",
    ".yarn",
    ".pnpm-store",
    ".cache",
    ".gradle",
    ".m2",
    "Caches",
    "DerivedData",
    "__pycache__",
    ".venv",
];
const AI: &[&str] = &[".ollama", ".lmstudio", "huggingface", ".diffusionbee"];
const SDK: &[&str] = &[".android", "Android", "CoreSimulator", "Xcode", "iOS DeviceSupport"];
const DEV_TOOLS: &[&str] = &[
    ".vscode", ".cursor", ".rustup", ".cargo", ".nvm", ".rbenv", ".rvm", ".pyenv", ".sdkman", ".docker", ".local", ".config", ".bun",
    ".deno", ".codex", ".claude", ".zed",
];

/// Folder names that decide each category, for the "How it works" screen.
pub fn examples() -> Vec<(Category, Vec<&'static str>)> {
    vec![
        (Category::Media, MEDIA.to_vec()),
        (Category::Code, vec!["any folder containing .git"]),
        (Category::DevTools, DEV_TOOLS.to_vec()),
        (Category::Sdk, SDK.to_vec()),
        (Category::AiModels, AI.to_vec()),
        (Category::Cache, CACHE.to_vec()),
        (Category::System, vec!["Library", "Applications"]),
    ]
}

/// Category of a node, given its parent's category and how deep it is below the home folder.
pub fn classify(node: &Node, parent: Category, depth_in_home: usize) -> Category {
    let name = &*node.name;
    // Caches win even inside code projects: node_modules in a repo is still a cache.
    if CACHE.contains(&name) {
        return Category::Cache;
    }
    if AI.contains(&name) {
        return Category::AiModels;
    }
    if SDK.contains(&name) {
        return Category::Sdk;
    }
    if parent != Category::Other && parent != Category::System && parent != Category::Media {
        return parent;
    }
    if node.children.iter().any(|c| &*c.name == ".git") {
        return Category::Code;
    }
    if depth_in_home == 1 {
        if MEDIA.contains(&name) {
            return Category::Media;
        }
        if DEV_TOOLS.contains(&name) {
            return Category::DevTools;
        }
        if name == "Library" || name == "Applications" {
            return Category::System;
        }
    }
    parent
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::Kind;

    fn dir(name: &str, children: Vec<Node>) -> Node {
        Node { name: name.into(), kind: Kind::Dir, size: 1, files: 0, modified: 0, children }
    }

    #[test]
    fn classifies_top_level_folders() {
        assert_eq!(classify(&dir("Documents", vec![]), Category::Other, 1), Category::Media);
        assert_eq!(classify(&dir(".vscode", vec![]), Category::Other, 1), Category::DevTools);
        assert_eq!(classify(&dir("Library", vec![]), Category::Other, 1), Category::System);
        assert_eq!(classify(&dir("misc", vec![]), Category::Other, 1), Category::Other);
    }

    #[test]
    fn detects_repositories_and_their_caches() {
        let repo = dir("atlas", vec![dir(".git", vec![]), dir("node_modules", vec![])]);
        assert_eq!(classify(&repo, Category::Other, 2), Category::Code);
        assert_eq!(classify(&dir("src", vec![]), Category::Code, 3), Category::Code);
        assert_eq!(classify(&dir("node_modules", vec![]), Category::Code, 3), Category::Cache);
    }

    #[test]
    fn finds_sdks_and_caches_inside_library() {
        assert_eq!(classify(&dir("Android", vec![]), Category::System, 2), Category::Sdk);
        assert_eq!(classify(&dir("Caches", vec![]), Category::System, 2), Category::Cache);
        assert_eq!(classify(&dir("Mail", vec![]), Category::System, 2), Category::System);
    }

    #[test]
    fn media_folders_only_count_at_the_top() {
        assert_eq!(classify(&dir("Music", vec![]), Category::Code, 3), Category::Code);
    }
}
