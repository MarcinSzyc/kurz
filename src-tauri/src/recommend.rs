//! Runs the cleanup rules against a scanned tree and returns what Kurz recommends removing.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::about::Owner;
use crate::categories::Category;
use crate::rules::{self, Matcher, RULES, Risk, Rule};
use crate::scanner::{Kind, Node};

const DAY: i64 = 86_400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable across scans: the rule id, plus the path for rules that yield one item per folder.
    pub id: String,
    pub rule: &'static str,
    pub label: String,
    pub risk: Risk,
    pub category: Category,
    /// What to show: one path, or a pattern like `~/Projects/*/node_modules`.
    pub location: String,
    /// Absolute paths this item removes.
    pub paths: Vec<String>,
    pub size: u64,
    /// Latest change (Unix seconds) in any of the paths.
    pub modified: i64,
    /// What it is, in a sentence; filled in by `about::describe` before reaching the UI.
    pub about: String,
    /// The app it belongs to, when Kurz can tell.
    pub owner: Option<Owner>,
}

struct Match {
    relative: PathBuf,
    size: u64,
    modified: i64,
}

/// Recommendations for the tree scanned at `home`, safest first and largest first within a group.
pub fn recommend(root: &Node, home: &Path, now: i64) -> Vec<Item> {
    let mut claimed: Vec<PathBuf> = Vec::new();
    let mut items = Vec::new();

    for rule in RULES {
        let matches: Vec<Match> = find_matches(rule, root, now)
            .into_iter()
            .filter(|m| !rules::is_protected(&m.relative.to_string_lossy()))
            .filter(|m| !claimed.iter().any(|c| m.relative.starts_with(c) || c.starts_with(&m.relative)))
            .collect();
        let new_items = to_items(rule, matches, home);
        for item in &new_items {
            claimed.extend(item.paths.iter().map(|p| Path::new(p).strip_prefix(home).unwrap().to_path_buf()));
        }
        items.extend(new_items);
    }

    items.sort_by(|a, b| a.risk.cmp(&b.risk).then(b.size.cmp(&a.size)));
    items
}

fn find_matches(rule: &Rule, root: &Node, now: i64) -> Vec<Match> {
    let at = |relative: PathBuf, node: &Node| Match { relative, size: node.size, modified: node.modified };
    match rule.matcher {
        Matcher::Path(path) => root.find(Path::new(path)).map(|n| at(PathBuf::from(path), n)).into_iter().collect(),
        Matcher::EachChildOf(path) => root
            .find(Path::new(path))
            .map(|parent| {
                parent
                    .children
                    .iter()
                    .filter(|c| c.kind == Kind::Dir && c.size >= rules::MIN_ITEM_SIZE)
                    .map(|c| at(Path::new(path).join(&*c.name), c))
                    .collect()
            })
            .unwrap_or_default(),
        Matcher::OldFilesIn(path, days) => root
            .find(Path::new(path))
            .map(|parent| {
                parent
                    .children
                    .iter()
                    .filter(|c| c.modified < now - days as i64 * DAY)
                    .map(|c| at(Path::new(path).join(&*c.name), c))
                    .collect()
            })
            .unwrap_or_default(),
        Matcher::NameNextTo(name, files) => {
            let mut out = Vec::new();
            walk_projects(root, PathBuf::new(), &mut |dir, relative| {
                let has_marker = dir.children.iter().any(|c| c.kind == Kind::File && files.contains(&&*c.name));
                let Some(target) = dir.children.iter().find(|c| &*c.name == name && c.kind == Kind::Dir) else {
                    return;
                };
                if !has_marker {
                    return;
                }
                if rule.needs_idle_project {
                    // The project's own last change, not counting the folder we'd remove.
                    let project_changed = dir.children.iter().filter(|c| &*c.name != name).map(|c| c.modified).max().unwrap_or(0);
                    if project_changed > now - rules::IDLE_DAYS as i64 * DAY {
                        return;
                    }
                }
                out.push(at(relative.join(name), target));
            });
            out
        }
        Matcher::IdleRepository(days) => {
            let mut out = Vec::new();
            walk_projects(root, PathBuf::new(), &mut |dir, relative| {
                for repo in dir.children.iter().filter(|c| c.kind == Kind::Dir && c.children.iter().any(|g| &*g.name == ".git")) {
                    if repo.modified < now - days as i64 * DAY && repo.size >= rules::MIN_ITEM_SIZE {
                        out.push(at(relative.join(&*repo.name), repo));
                    }
                }
            });
            out
        }
    }
}

/// Visits folders where projects live: skips ~/Library, hidden top-level folders,
/// and never descends into dependency folders or repository internals.
fn walk_projects(node: &Node, relative: PathBuf, visit: &mut impl FnMut(&Node, &Path)) {
    visit(node, &relative);
    for child in node.children.iter().filter(|c| c.kind == Kind::Dir) {
        let name = &*child.name;
        let top_level = relative.as_os_str().is_empty();
        if (top_level && (name == "Library" || name.starts_with('.'))) || matches!(name, "node_modules" | ".git" | "target" | ".next") {
            continue;
        }
        walk_projects(child, relative.join(name), visit);
    }
}

fn to_items(rule: &Rule, matches: Vec<Match>, home: &Path) -> Vec<Item> {
    let abs = |m: &Match| home.join(&m.relative).to_string_lossy().into_owned();
    let tilde = |p: &Path| format!("~/{}", p.to_string_lossy());

    match rule.matcher {
        // One row per folder: each simulator, each app cache, each idle repository.
        Matcher::EachChildOf(_) | Matcher::IdleRepository(_) => matches
            .into_iter()
            .filter(|m| m.size >= rules::MIN_ITEM_SIZE)
            .map(|m| {
                let name = m.relative.file_name().unwrap().to_string_lossy();
                let label = match rule.id {
                    "android-avds" => format!("{} emulator", name.trim_end_matches(".avd")),
                    "app-caches" => format!("{name} cache"),
                    _ => name.into_owned(),
                };
                Item {
                    id: format!("{}:{}", rule.id, m.relative.to_string_lossy()),
                    rule: rule.id,
                    label,
                    risk: rule.risk,
                    category: rule.category,
                    location: tilde(&m.relative),
                    paths: vec![abs(&m)],
                    size: m.size,
                    modified: m.modified,
                    about: String::new(),
                    owner: None,
                }
            })
            .collect(),
        // Everything else is one row, possibly spanning many folders.
        _ => {
            let size: u64 = matches.iter().map(|m| m.size).sum();
            if matches.is_empty() || size < rules::MIN_ITEM_SIZE {
                return Vec::new();
            }
            let count = matches.len();
            let label = match (rule.matcher, count) {
                (Matcher::NameNextTo(..), n) if n > 1 => format!("{} ({n} projects)", rule.label),
                (Matcher::OldFilesIn(..), n) => format!("{} ({n} files)", rule.label),
                _ => rule.label.to_string(),
            };
            let location = match rule.matcher {
                Matcher::NameNextTo(name, _) if count > 1 => pattern(&matches, name),
                Matcher::OldFilesIn(dir, _) => format!("~/{dir}"),
                _ => tilde(&matches[0].relative),
            };
            vec![Item {
                id: rule.id.to_string(),
                rule: rule.id,
                label,
                risk: rule.risk,
                category: rule.category,
                location,
                paths: matches.iter().map(abs).collect(),
                size,
                modified: matches.iter().map(|m| m.modified).max().unwrap_or(0),
                about: String::new(),
                owner: None,
            }]
        }
    }
}

/// `~/Projects/*/node_modules` when the projects share a parent, else `~/…/node_modules`.
fn pattern(matches: &[Match], name: &str) -> String {
    let grandparent = |m: &Match| m.relative.parent().and_then(Path::parent).map(Path::to_path_buf);
    let first = grandparent(&matches[0]);
    match first {
        Some(g) if matches.iter().all(|m| grandparent(m).as_ref() == Some(&g)) && !g.as_os_str().is_empty() => {
            format!("~/{}/*/{name}", g.to_string_lossy())
        }
        _ => format!("~/…/{name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const GB: u64 = 1_000_000_000;

    fn file(name: &str, size: u64, age_days: i64) -> Node {
        Node { name: name.into(), kind: Kind::File, size, files: 1, modified: NOW - age_days * DAY, children: vec![] }
    }

    fn dir(name: &str, children: Vec<Node>) -> Node {
        let size = children.iter().map(|c| c.size).sum();
        let files = children.iter().map(|c| c.files).sum();
        let modified = children.iter().map(|c| c.modified).max().unwrap_or(0);
        Node { name: name.into(), kind: Kind::Dir, size, files, modified, children }
    }

    fn project(name: &str, age_days: i64, deps: u64) -> Node {
        dir(name, vec![file("package.json", 1_000, age_days), dir("node_modules", vec![file("x.js", deps, 1)])])
    }

    fn home() -> Node {
        dir(
            "me",
            vec![
                dir(".npm", vec![dir("_cacache", vec![file("blob", 3 * GB, 5)])]),
                dir(
                    "Library",
                    vec![dir(
                        "Caches",
                        vec![
                            dir("Yarn", vec![file("y", GB, 1)]),
                            dir("com.spotify.client", vec![file("s", 2 * GB, 1)]),
                            dir("tiny", vec![file("t", 1_000, 1)]),
                        ],
                    )],
                ),
                dir(
                    "Projects",
                    vec![
                        project("old-a", 90, GB),
                        project("old-b", 45, GB),
                        project("active", 2, GB),
                        dir("ancient", vec![dir(".git", vec![file("pack", GB, 500)]), file("main.rs", 10, 500)]),
                    ],
                ),
                dir("Documents", vec![dir("node_modules", vec![file("x", GB, 1)]), file("package.json", 1, 100)]),
            ],
        )
    }

    fn by_id<'a>(items: &'a [Item], id: &str) -> &'a Item {
        items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no item {id} in {:?}", items.iter().map(|i| &i.id).collect::<Vec<_>>()))
    }

    #[test]
    fn finds_fixed_paths() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        let npm = by_id(&items, "npm-cache");
        assert_eq!(npm.paths, vec!["/Users/me/.npm/_cacache"]);
        assert_eq!(npm.size, 3 * GB);
        assert_eq!(npm.risk, Risk::Safe);
    }

    #[test]
    fn groups_node_modules_of_idle_projects_only() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        let nm = by_id(&items, "idle-node-modules");
        assert_eq!(nm.label, "node_modules (2 projects)");
        assert_eq!(nm.location, "~/Projects/*/node_modules");
        assert_eq!(nm.size, 2 * GB);
        assert!(nm.paths.iter().all(|p| !p.contains("active")));
    }

    #[test]
    fn never_matches_inside_protected_places() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        assert!(items.iter().all(|i| i.paths.iter().all(|p| !p.contains("Documents"))));
    }

    #[test]
    fn specific_cache_rules_win_over_the_generic_one() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        assert_eq!(by_id(&items, "yarn-cache").paths, vec!["/Users/me/Library/Caches/Yarn"]);
        let spotify = by_id(&items, "app-caches:Library/Caches/com.spotify.client");
        assert_eq!(spotify.label, "com.spotify.client cache");
        assert!(!items.iter().any(|i| i.id == "app-caches:Library/Caches/Yarn"));
        assert!(!items.iter().any(|i| i.id.ends_with("tiny")), "items under the minimum size are left out");
    }

    #[test]
    fn offers_long_idle_repositories_for_a_look() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        let repo = by_id(&items, "idle-projects:Projects/ancient");
        assert_eq!(repo.risk, Risk::TakeALook);
    }

    #[test]
    fn sorts_safe_first_then_by_size() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        for pair in items.windows(2) {
            assert!(pair[0].risk < pair[1].risk || (pair[0].risk == pair[1].risk && pair[0].size >= pair[1].size));
        }
    }

    #[test]
    fn no_path_is_claimed_twice() {
        let items = recommend(&home(), Path::new("/Users/me"), NOW);
        let all: Vec<&String> = items.iter().flat_map(|i| &i.paths).collect();
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert!(!a.starts_with(b.as_str()) && !b.starts_with(a.as_str()), "{a} overlaps {b}");
            }
        }
    }
}
