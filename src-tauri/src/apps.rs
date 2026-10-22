//! Installed apps for the Apps tab (design/apps.html): what each one is, how big it is with its data
//! in ~/Library, when it was installed and last opened, and data left behind by apps that are gone.
//! Everything comes from the Mac itself: Info.plist, Spotlight and LaunchServices.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use objc2_foundation::{NSBundle, NSString};
use serde::Serialize;

use crate::about;
use crate::scanner::{self, Progress};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// "Application", "Caches", "Application Support", …
    pub kind: &'static str,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub vendor: Option<String>,
    /// App Store category, e.g. "Developer Tools".
    pub category: Option<String>,
    /// The .app first, then its folders in ~/Library.
    pub parts: Vec<Part>,
    /// Unix seconds.
    pub installed: Option<i64>,
    pub last_opened: Option<i64>,
    /// `last_opened` is the last change to the app's data, as Spotlight had no record.
    pub last_opened_estimated: bool,
    pub running: bool,
    pub app_store: bool,
    /// Ships its own uninstaller, which also removes helpers and login items.
    pub own_uninstaller: bool,
    /// Installed for all users (owned by another account, usually root): removing it asks for an
    /// administrator password.
    pub needs_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub id: String,
    /// A guess at the app's name from its bundle id.
    pub guess: String,
    /// The largest of the paths, for display.
    pub location: String,
    pub paths: Vec<String>,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsReport {
    pub apps: Vec<InstalledApp>,
    pub leftovers: Vec<Leftover>,
    /// Names of apps that are part of macOS and can't be uninstalled.
    pub system: Vec<String>,
}

/// Folders in ~/Library where apps keep data, named after their bundle id (or name).
const DATA_DIRS: &[(&str, &str)] = &[
    ("Caches", "Caches"),
    ("Application Support", "Application Support"),
    ("Containers", "Containers"),
    ("Saved Application State", "Saved state"),
    ("Logs", "Logs"),
    ("HTTPStorages", "Web storage"),
    ("WebKit", "Web storage"),
    ("Preferences", "Preferences"),
];

/// Apps that come with an uninstaller of their own.
const OWN_UNINSTALLER: &[&str] = &["com.docker.", "com.adobe.", "com.parallels.", "com.vmware."];

const CATEGORIES: &[(&str, &str)] = &[
    ("developer-tools", "Developer Tools"),
    ("graphics-design", "Graphics & Design"),
    ("healthcare-fitness", "Health & Fitness"),
    ("social-networking", "Social Networking"),
    ("photography", "Photography"),
    ("productivity", "Productivity"),
    ("utilities", "Utilities"),
    ("business", "Business"),
    ("music", "Music"),
    ("video", "Video"),
    ("entertainment", "Entertainment"),
    ("education", "Education"),
    ("finance", "Finance"),
    ("games", "Games"),
    ("lifestyle", "Lifestyle"),
    ("news", "News"),
    ("reference", "Reference"),
];

fn category(raw: &str) -> String {
    let key = raw.trim_start_matches("public.app-category.");
    CATEGORIES.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string()).unwrap_or_else(|| {
        key.split('-').map(|w| w[..1].to_uppercase() + &w[1..]).collect::<Vec<_>>().join(" ")
    })
}

/// "Copyright © 2023 Docker Inc. All rights reserved." → "Docker Inc."
fn vendor_from_copyright(raw: &str) -> Option<String> {
    let mut s = raw.replace("Copyright", "").replace('©', "").replace("(c)", "").replace("(C)", "");
    for cut in ["All rights reserved", "All Rights Reserved", "all rights reserved"] {
        if let Some(i) = s.find(cut) {
            s.truncate(i);
        }
    }
    let s = s.trim_matches(|c: char| c.is_whitespace() || c == '.' || c == ',');
    // Drop leading years like "2012-2024".
    let s = s.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '–' || c == ' ' || c == ',');
    let s = s.trim().trim_end_matches(['.', ',']).trim();
    (!s.is_empty() && s.len() < 60).then(|| if s.ends_with("Inc") || s.ends_with("Ltd") { format!("{s}.") } else { s.to_string() })
}

/// Words in bundle ids that don't name the app: "com.parallels.desktop.console" is Parallels.
const GENERIC: &[&str] = &["app", "mac", "macos", "osx", "xos", "desktop", "client", "console", "helper", "agent", "launcher", "main"];

/// "com.hnc.Discord" → "Discord", "org.videolan.vlc" → "VLC"
fn guess_name(bundle_id: &str) -> String {
    let parts: Vec<&str> = bundle_id.split('.').skip(1).collect();
    let word = parts.iter().rev().find(|p| !GENERIC.contains(&p.to_lowercase().as_str())).or(parts.last()).copied().unwrap_or(bundle_id);
    if word.len() <= 3 {
        return word.to_uppercase();
    }
    let mut c = word.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Allocated size of a file or folder, without following symlinks.
pub fn size_of(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => scanner::scan(path, &AtomicBool::new(false), &Progress::default()).ok().flatten().map_or(0, |n| n.size),
        Ok(m) => {
            use std::os::unix::fs::MetadataExt;
            m.blocks() * 512
        }
        Err(_) => 0,
    }
}

fn modified_of(path: &Path) -> i64 {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => scanner::scan(path, &AtomicBool::new(false), &Progress::default()).ok().flatten().map_or(0, |n| n.modified),
        Ok(m) => {
            use std::os::unix::fs::MetadataExt;
            m.mtime()
        }
        Err(_) => 0,
    }
}

struct Info {
    id: String,
    name: String,
    version: Option<String>,
    vendor: Option<String>,
    category: Option<String>,
}

fn read_info(app: &Path) -> Option<Info> {
    let bundle = NSBundle::bundleWithPath(&NSString::from_str(&app.to_string_lossy()))?;
    let id = bundle.bundleIdentifier()?.to_string();
    let get = |key: &str| -> Option<String> {
        let obj = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;
        obj.downcast::<NSString>().ok().map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
    };
    let file_name = app.file_stem()?.to_string_lossy().into_owned();
    Some(Info {
        name: get("CFBundleDisplayName").or_else(|| get("CFBundleName")).filter(|n| n.len() > 1).unwrap_or(file_name),
        version: get("CFBundleShortVersionString"),
        vendor: get("NSHumanReadableCopyright").as_deref().and_then(vendor_from_copyright),
        category: get("LSApplicationCategoryType").map(|c| category(&c)),
        id,
    })
}

/// Days since the epoch → (year, month, day), from Howard Hinnant's civil calendar algorithms.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-10-16 14:36:14 +0000" → Unix seconds.
fn parse_mdls_date(s: &str) -> Option<i64> {
    let (date, rest) = s.trim().split_once(' ')?;
    let time = rest.split(' ').next()?;
    let d: Vec<i64> = date.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let t: Vec<i64> = time.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    (d.len() == 3 && t.len() == 3).then(|| days_from_civil(d[0], d[1], d[2]) * 86_400 + t[0] * 3600 + t[1] * 60 + t[2])
}

/// One Spotlight attribute for many files, in one `mdls` call.
fn spotlight_dates(attribute: &str, paths: &[PathBuf]) -> Vec<Option<i64>> {
    if paths.is_empty() {
        return vec![];
    }
    let output = Command::new("/usr/bin/mdls").arg("-name").arg(attribute).arg("-raw").args(paths).output();
    let Ok(output) = output else { return vec![None; paths.len()] };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut values: Vec<Option<i64>> = text.split('\0').map(|v| if v == "(null)" { None } else { parse_mdls_date(v) }).collect();
    values.resize(paths.len(), None);
    values
}

/// Where apps are installed: /Applications (and folders inside it, like "Adobe Photoshop 2023/"),
/// and ~/Applications.
fn app_bundles(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [PathBuf::from("/Applications"), home.join("Applications")] {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_app = path.extension().is_some_and(|e| e == "app");
            // Real folders only: Safari in /Applications is a link into the sealed system.
            let real_dir = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
            if is_app && real_dir {
                out.push(path);
            } else if !is_app && real_dir && root == Path::new("/Applications") && path.file_name().is_some_and(|n| n != "Utilities") {
                for inner in fs::read_dir(&path).into_iter().flatten().flatten() {
                    let p = inner.path();
                    if p.extension().is_some_and(|e| e == "app") && fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

/// Why an app bundle may not be removed, checked again right before removing it. Asks a running
/// app to quit and waits a few seconds for it.
pub fn check_removable(app: &Path, home: &Path) -> Result<(), String> {
    let in_apps = |root: &Path| app.parent() == Some(root) || app.parent().and_then(Path::parent) == Some(root);
    if app.extension().is_none_or(|e| e != "app") || !(in_apps(Path::new("/Applications")) || in_apps(&home.join("Applications"))) {
        return Err("Only apps in /Applications or ~/Applications can be uninstalled".into());
    }
    if !fs::symlink_metadata(app).is_ok_and(|m| m.is_dir()) {
        return Err("It's no longer there".into());
    }
    let info = read_info(app).ok_or("Not an app Kurz can read")?;
    if is_system(&info.id, app) || info.id == "com.marcinszyc.kurz" {
        return Err("Part of macOS".into());
    }
    if about::is_running(&info.id) {
        about::ask_to_quit(&info.id);
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if !about::is_running(&info.id) {
                return Ok(());
            }
        }
        return Err(format!("{} is still running; quit it and try again", info.name));
    }
    Ok(())
}

/// Apple's own apps, except those from the App Store (Xcode, GarageBand…), are part of macOS.
fn is_system(id: &str, app: &Path) -> bool {
    id.starts_with("com.apple.") && !app.join("Contents/_MASReceipt/receipt").exists()
}

/// Names of the apps that ship with macOS, for the "Part of macOS" row.
fn system_app_names() -> Vec<String> {
    let mut names: Vec<String> = ["/System/Applications", "/System/Applications/Utilities"]
        .iter()
        .flat_map(|d| fs::read_dir(d).into_iter().flatten().flatten())
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned()))
        .filter(|n| n != "Utilities")
        .collect();
    if Path::new("/Applications/Safari.app").exists() {
        names.push("Safari".into());
    }
    names.sort();
    names.dedup();
    names
}

/// The data an app keeps in ~/Library, found by bundle id and by name.
fn data_parts(home: &Path, id: &str, name: &str) -> Vec<Part> {
    let library = home.join("Library");
    let mut parts = Vec::new();
    let mut seen = HashSet::new();
    for (dir, kind) in DATA_DIRS {
        let base = library.join(dir);
        let candidates: Vec<PathBuf> = if *dir == "Preferences" {
            vec![base.join(format!("{id}.plist"))]
        } else if *dir == "Saved Application State" {
            vec![base.join(format!("{id}.savedState"))]
        } else if *dir == "Containers" {
            vec![base.join(id)]
        } else {
            vec![base.join(id), base.join(name), base.join(format!("{id}.ShipIt"))]
        };
        for path in candidates {
            // Apple's own data (e.g. Xcode's container) is never offered for removal.
            let protected = path.strip_prefix(home).is_ok_and(|r| crate::rules::is_protected(&r.to_string_lossy()));
            if !protected && fs::symlink_metadata(&path).is_ok() && seen.insert(path.clone()) {
                parts.push(Part { kind, path: path.to_string_lossy().into_owned(), size: size_of(&path) });
            }
        }
    }
    parts
}

/// Data in ~/Library named after apps that aren't installed. Skips Apple's own, anything from a
/// vendor that still has an app installed (helpers and updaters share its prefix), and running ones.
fn leftovers(home: &Path, installed: &[String]) -> Vec<Leftover> {
    let library = home.join("Library");
    let vendor_of = |id: &str| id.splitn(3, '.').take(2).collect::<Vec<_>>().join(".");
    let vendors: HashSet<String> = installed.iter().map(|id| vendor_of(id)).collect();
    let mut by_id: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for (dir, _) in DATA_DIRS {
        for entry in fs::read_dir(library.join(dir)).into_iter().flatten().flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            let id = file.trim_end_matches(".plist").trim_end_matches(".savedState").trim_end_matches(".ShipIt").to_string();
            if !about::looks_like_bundle_id(&id) || id.starts_with("com.apple.") || id == "com.marcinszyc.kurz" {
                continue;
            }
            if installed.contains(&id) || vendors.contains(&vendor_of(&id)) {
                continue;
            }
            by_id.entry(id).or_default().push(entry.path());
        }
    }
    let mut out: Vec<Leftover> = by_id
        .into_iter()
        .filter(|(id, _)| about::app_name(id).is_none() && !about::is_running(id))
        .map(|(id, paths)| {
            let sized: Vec<(PathBuf, u64)> = paths.into_iter().map(|p| { let s = size_of(&p); (p, s) }).collect();
            let largest = sized.iter().max_by_key(|(_, s)| *s).map(|(p, _)| p.clone()).unwrap();
            Leftover {
                guess: guess_name(&id),
                location: format!("~/{}", largest.strip_prefix(home).unwrap_or(&largest).to_string_lossy()),
                size: sized.iter().map(|(_, s)| s).sum(),
                modified: sized.iter().map(|(p, _)| modified_of(p)).max().unwrap_or(0),
                paths: sized.into_iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect(),
                id,
            }
        })
        // Skip lone preference files and other crumbs.
        .filter(|l| l.size >= 1_000_000)
        .collect();
    out.sort_by_key(|l| std::cmp::Reverse(l.size));
    out
}

/// Reads every installed app. `progress(done, total, current)` is called as each app is sized.
pub fn list(home: &Path, mut progress: impl FnMut(usize, usize, &str)) -> AppsReport {
    let bundles = app_bundles(home);
    let infos: Vec<(PathBuf, Info)> = bundles
        .into_iter()
        .filter_map(|p| read_info(&p).map(|i| (p, i)))
        .filter(|(p, i)| !is_system(&i.id, p) && i.id != "com.marcinszyc.kurz")
        .collect();
    let paths: Vec<PathBuf> = infos.iter().map(|(p, _)| p.clone()).collect();
    let last_used = spotlight_dates("kMDItemLastUsedDate", &paths);
    let added = spotlight_dates("kMDItemDateAdded", &paths);

    let total = infos.len();
    let mut apps = Vec::with_capacity(total);
    for (i, (path, info)) in infos.into_iter().enumerate() {
        progress(i, total, &path.to_string_lossy());
        let data = data_parts(home, &info.id, &info.name);
        let estimated = last_used[i].is_none();
        let last_opened = last_used[i].or_else(|| data.iter().map(|p| modified_of(Path::new(&p.path))).max().filter(|t| *t > 0));
        let created = fs::metadata(&path).and_then(|m| m.created()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
        let mut parts = vec![Part { kind: "Application", path: path.to_string_lossy().into_owned(), size: size_of(&path) }];
        parts.extend(data);
        apps.push(InstalledApp {
            running: about::is_running(&info.id),
            app_store: path.join("Contents/_MASReceipt/receipt").exists(),
            own_uninstaller: OWN_UNINSTALLER.iter().any(|p| info.id.starts_with(p)),
            // SAFETY: getuid can't fail.
            needs_admin: {
                use std::os::unix::fs::MetadataExt;
                fs::symlink_metadata(&path).is_ok_and(|m| m.uid() != unsafe { libc::getuid() })
            },
            installed: added[i].or(created),
            last_opened_estimated: estimated && last_opened.is_some(),
            last_opened,
            parts,
            id: info.id,
            name: info.name,
            version: info.version,
            vendor: info.vendor,
            category: info.category,
        });
    }
    progress(total, total, "");
    let ids: Vec<String> = apps.iter().map(|a| a.id.clone()).collect();
    AppsReport { leftovers: leftovers(home, &ids), apps, system: system_app_names() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_categories() {
        assert_eq!(category("public.app-category.developer-tools"), "Developer Tools");
        assert_eq!(category("public.app-category.graphics-design"), "Graphics & Design");
        assert_eq!(category("public.app-category.weather"), "Weather");
    }

    #[test]
    fn reads_vendors_from_copyright_lines() {
        assert_eq!(vendor_from_copyright("Copyright © 2023 Docker Inc. All rights reserved.").as_deref(), Some("Docker Inc."));
        assert_eq!(vendor_from_copyright("© 2012-2024 Spotify AB").as_deref(), Some("Spotify AB"));
        assert_eq!(vendor_from_copyright("").as_deref(), None);
    }

    #[test]
    fn guesses_app_names_from_bundle_ids() {
        assert_eq!(guess_name("com.hnc.Discord"), "Discord");
        assert_eq!(guess_name("org.videolan.vlc"), "VLC");
        assert_eq!(guess_name("com.parallels.desktop.console"), "Parallels");
    }

    #[test]
    fn parses_spotlight_dates() {
        assert_eq!(parse_mdls_date("1970-01-02 00:00:10 +0000"), Some(86_410));
        assert_eq!(parse_mdls_date("2026-10-16 14:36:14 +0000"), Some(1_792_161_374));
        assert_eq!(parse_mdls_date("(null)"), None);
    }

    #[test]
    fn treats_apple_apps_without_a_receipt_as_system() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(is_system("com.apple.Safari", tmp.path()));
        assert!(!is_system("com.spotify.client", tmp.path()));
        fs::create_dir_all(tmp.path().join("Contents/_MASReceipt")).unwrap();
        fs::write(tmp.path().join("Contents/_MASReceipt/receipt"), b"x").unwrap();
        assert!(!is_system("com.apple.dt.Xcode", tmp.path()), "App Store apps from Apple can be removed");
    }

    #[test]
    fn finds_app_data_by_id_and_name() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("Library");
        fs::create_dir_all(lib.join("Caches/com.example.app")).unwrap();
        fs::write(lib.join("Caches/com.example.app/blob"), vec![1u8; 5000]).unwrap();
        fs::create_dir_all(lib.join("Application Support/Example")).unwrap();
        fs::create_dir_all(lib.join("Preferences")).unwrap();
        fs::write(lib.join("Preferences/com.example.app.plist"), b"x").unwrap();

        let parts = data_parts(tmp.path(), "com.example.app", "Example");

        let kinds: Vec<&str> = parts.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["Caches", "Application Support", "Preferences"]);
        assert!(parts[0].size >= 5000);
    }

    #[test]
    fn finds_leftovers_of_removed_apps_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("Library");
        for dir in ["Application Support/com.example.gone-app", "Caches/com.example.gone-app", "Caches/com.vendor.updater", "Caches/com.apple.Safari"] {
            fs::create_dir_all(lib.join(dir)).unwrap();
            fs::write(lib.join(dir).join("data"), vec![1u8; 700_000]).unwrap();
        }
        // com.vendor has an installed app, so its updater's cache isn't a leftover.
        let found = leftovers(tmp.path(), &["com.vendor.app".to_string()]);

        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].id, "com.example.gone-app");
        assert_eq!(found[0].guess, "Gone-app");
        assert_eq!(found[0].paths.len(), 2);
    }

    #[test]
    fn only_removes_app_bundles_from_application_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fs::create_dir_all(home.join("Documents/Tool.app")).unwrap();
        fs::create_dir_all(home.join("Applications/Folder")).unwrap();
        assert!(check_removable(&home.join("Documents/Tool.app"), home).is_err(), "not in an Applications folder");
        assert!(check_removable(&home.join("Applications/Folder"), home).is_err(), "not an .app");
        assert!(check_removable(Path::new("/System/Applications/Calculator.app"), home).is_err(), "part of macOS");
        assert!(check_removable(&home.join("Applications/Gone.app"), home).is_err(), "missing");
    }

    /// Lists the real apps on this Mac: KURZ_LIST_APPS=1 cargo test print_apps -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_apps() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let started = std::time::Instant::now();
        let report = list(&home, |_, _, _| {});
        println!("{} apps, {} leftovers, {} system in {:.1?}", report.apps.len(), report.leftovers.len(), report.system.len(), started.elapsed());
        for a in report.apps.iter().take(12) {
            let size: u64 = a.parts.iter().map(|p| p.size).sum();
            println!("{:<28} {:<10} {:<22} {:<18} {:>7.2} GB parts={} last={:?}{} inst={:?} run={} store={}",
                a.name, a.version.clone().unwrap_or_default(), a.vendor.clone().unwrap_or_default(), a.category.clone().unwrap_or_default(),
                size as f64 / 1e9, a.parts.len(), a.last_opened, if a.last_opened_estimated { "~" } else { "" }, a.installed, a.running, a.app_store);
        }
        for l in report.leftovers.iter().take(8) {
            println!("LEFT {:<40} {:<16} {:>7.2} GB {}", l.id, l.guess, l.size as f64 / 1e9, l.location);
        }
    }
}
