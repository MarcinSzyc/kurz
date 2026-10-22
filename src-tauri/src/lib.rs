mod about;
mod access;
mod apps;
pub mod cache;
mod categories;
pub mod cleanup;
mod disk;
mod docker;
mod gauge;
mod history;
mod menubar;
pub mod recommend;
mod rules;
pub mod scanner;
mod settings;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

use categories::Category;
use menubar::MenuBar;
use settings::MenuBarSettings;

use scanner::{Kind, Node, Progress};

/// Children beyond this many are folded into a single "rest" entry.
const MAX_CHILDREN: usize = 150;
/// Children smaller than this share of the requested subtree are folded too,
/// so a deep tree stays small enough to send to the UI.
const MIN_SHARE: f64 = 0.0005;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

struct ScanResult {
    root: PathBuf,
    tree: Node,
    stats: cache::Stats,
}

fn scan_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("last-scan.bin"))
}

/// Saves the scan in the background, so the next launch opens with it.
fn save_scan(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some(path) = scan_cache_path(&app) else { return };
        let state = app.state::<AppState>();
        let guard = state.result.lock().unwrap();
        if let Some(r) = guard.as_ref() {
            let _ = cache::save(&path, &r.root, &r.tree, r.stats);
        }
    });
}

#[derive(Default)]
struct AppState {
    result: Mutex<Option<ScanResult>>,
    scanning: AtomicBool,
    cancel: Arc<AtomicBool>,
    cleaning: AtomicBool,
    /// Subtrees taken out of the scan by a cleanup, by original path, so a restore can put them back.
    removed: Mutex<HashMap<String, Node>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    elapsed_ms: u64,
}

impl ProgressEvent {
    fn from(progress: &Progress, started: Instant) -> Self {
        Self {
            files: progress.files.load(Ordering::Relaxed),
            dirs: progress.dirs.load(Ordering::Relaxed),
            bytes: progress.bytes.load(Ordering::Relaxed),
            errors: progress.errors.load(Ordering::Relaxed),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    root: String,
    cancelled: bool,
    error: Option<String>,
    progress: ProgressEvent,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeView {
    name: String,
    path: String,
    /// `rest` stands for the children folded together past `MAX_CHILDREN`.
    kind: &'static str,
    category: Category,
    size: u64,
    files: u64,
    /// `None` when the depth limit cut the tree here or the node has no children.
    children: Option<Vec<NodeView>>,
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Dir => "dir",
        Kind::File => "file",
        Kind::Symlink => "symlink",
        Kind::Other => "other",
    }
}

/// `level` is how deep `node` is below the scan root, which classification needs.
fn view(node: &Node, path: PathBuf, depth: u32, min_size: u64, category: Category, level: usize) -> NodeView {
    let children = (depth > 0 && !node.children.is_empty()).then(|| {
        // Children are sorted by size, so the shown ones are a prefix.
        let shown = node.children.iter().take(MAX_CHILDREN).take_while(|c| c.size >= min_size).count();
        let mut views: Vec<NodeView> = node.children[..shown]
            .iter()
            .map(|c| {
                let child_category = categories::classify(c, category, level + 1);
                view(c, path.join(&*c.name), depth - 1, min_size, child_category, level + 1)
            })
            .collect();
        let rest = &node.children[shown..];
        if !rest.is_empty() {
            views.push(NodeView {
                name: format!("{} more items", rest.len()),
                path: path.to_string_lossy().into_owned(),
                kind: "rest",
                category,
                size: rest.iter().map(|c| c.size).sum(),
                files: rest.iter().map(|c| c.files).sum(),
                children: None,
            });
        }
        views
    });
    NodeView {
        name: node.name.to_string(),
        path: path.to_string_lossy().into_owned(),
        kind: kind_name(node.kind),
        category,
        size: node.size,
        files: node.files,
        children,
    }
}

#[tauri::command]
fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path().home_dir().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

/// Starts scanning `path` in the background. Progress arrives as `scan-progress`
/// events and the end as one `scan-done` event.
#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let root = PathBuf::from(path);

    thread::spawn(move || {
        let progress = Progress::default();
        let started = Instant::now();
        let finished = AtomicBool::new(false);

        let outcome = thread::scope(|s| {
            s.spawn(|| {
                while !finished.load(Ordering::Relaxed) {
                    let _ = app.emit("scan-progress", ProgressEvent::from(&progress, started));
                    thread::sleep(PROGRESS_INTERVAL);
                }
            });
            let outcome = scanner::scan(&root, &cancel, &progress);
            finished.store(true, Ordering::Relaxed);
            outcome
        });

        let state = app.state::<AppState>();
        let (cancelled, error) = match outcome {
            Ok(Some(tree)) => {
                let items = recommend::recommend(&tree, &root, now());
                if let Ok(path) = history_path(&app) {
                    let _ = history::update(&path, |h| {
                        h.record_sizes(now(), items.iter().map(|i| (i.id.as_str(), i.label.as_str(), i.location.as_str(), i.size)))
                    });
                }
                let stats = cache::Stats {
                    scanned_at: now(),
                    files: progress.files.load(Ordering::Relaxed),
                    dirs: progress.dirs.load(Ordering::Relaxed),
                    errors: progress.errors.load(Ordering::Relaxed),
                };
                *state.result.lock().unwrap() = Some(ScanResult { root: root.clone(), tree, stats });
                save_scan(&app);
                (false, None)
            }
            Ok(None) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        state.scanning.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "scan-done",
            DoneEvent { root: root.to_string_lossy().into_owned(), cancelled, error, progress: ProgressEvent::from(&progress, started) },
        );
    });
    Ok(())
}

#[tauri::command]
fn disk_info(path: String) -> Result<disk::DiskInfo, String> {
    disk::disk_info(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Returns the subtree at `path` (the scan root when omitted), `depth` levels deep.
#[tauri::command]
fn get_tree(state: State<AppState>, path: Option<String>, depth: u32) -> Result<NodeView, String> {
    let guard = state.result.lock().unwrap();
    let result = guard.as_ref().ok_or("Nothing has been scanned yet")?;
    let path = path.map_or_else(|| result.root.clone(), PathBuf::from);
    let relative = path.strip_prefix(&result.root).map_err(|_| "Path is outside the scanned folder")?;
    // Walk down from the root so the node inherits its ancestors' category.
    let mut node = &result.tree;
    let mut category = Category::Other;
    let mut level = 0;
    for name in relative.iter() {
        let name = name.to_str().ok_or("Path is not valid UTF-8")?;
        node = node.children.iter().find(|c| &*c.name == name).ok_or("Path not found in the scan")?;
        level += 1;
        category = categories::classify(node, category, level);
    }
    let min_size = (node.size as f64 * MIN_SHARE) as u64;
    Ok(view(node, path, depth, min_size, category, level))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("settings.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_menu_bar_settings(menu_bar: State<MenuBar>) -> MenuBarSettings {
    menu_bar.settings()
}

/// Saves the settings and redraws the menu bar item with them.
#[tauri::command]
fn set_menu_bar_settings(app: AppHandle, menu_bar: State<MenuBar>, settings: MenuBarSettings) -> Result<MenuBarSettings, String> {
    let settings = settings.sanitized();
    let path = settings_path(&app)?;
    let mut all = settings::load(&path);
    all.menu_bar = settings.clone();
    settings::save(&path, &all).map_err(|e| e.to_string())?;
    menu_bar.apply(settings.clone());
    Ok(settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleView {
    id: &'static str,
    label: &'static str,
    risk: rules::Risk,
    matches: String,
    needs_idle_project: bool,
    reason: &'static str,
    restore: &'static str,
    command: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryView {
    category: Category,
    examples: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HowItWorks {
    rules: Vec<RuleView>,
    never: Vec<(String, &'static str)>,
    categories: Vec<CategoryView>,
    idle_days: u32,
    max_children: usize,
    min_share: f64,
}

/// Everything the "How it works" screen shows, straight from the rules the app uses.
#[tauri::command]
fn how_it_works() -> HowItWorks {
    HowItWorks {
        rules: rules::RULES
            .iter()
            .map(|r| RuleView {
                id: r.id,
                label: r.label,
                risk: r.risk,
                matches: r.matcher.describe(),
                needs_idle_project: r.needs_idle_project,
                reason: r.reason,
                restore: r.restore,
                command: r.command,
            })
            .collect(),
        never: rules::NEVER.iter().map(|(path, what)| (format!("~/{path}"), *what)).collect(),
        categories: categories::examples().into_iter().map(|(category, examples)| CategoryView { category, examples }).collect(),
        idle_days: rules::IDLE_DAYS,
        max_children: MAX_CHILDREN,
        min_share: MIN_SHARE,
    }
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("history.json")).map_err(|e| e.to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[tauri::command]
fn get_recommendations(state: State<AppState>) -> Result<Vec<recommend::Item>, String> {
    let guard = state.result.lock().unwrap();
    let result = guard.as_ref().ok_or("Nothing has been scanned yet")?;
    let mut items = recommend::recommend(&result.tree, &result.root, now());
    drop(guard);
    for item in &mut items {
        let reason = rules::RULES.iter().find(|r| r.id == item.rule).map_or("", |r| r.reason);
        let single = (item.paths.len() == 1).then(|| Path::new(&item.paths[0]));
        let about = about::describe(item.rule, reason, single);
        if let Some(label) = about.label {
            item.label = label;
        }
        item.about = about.what;
        item.owner = about.owner;
    }
    Ok(items)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanRequest {
    label: String,
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanProgress {
    done: usize,
    total: usize,
    current: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    path: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanReport {
    /// `None` when nothing could be removed.
    cleanup: Option<history::Cleanup>,
    freed: u64,
    failed: Vec<Failure>,
}

/// Scans `path` again and puts the result in the tree in place of the old one, then tells the UI.
/// For folders that change outside Kurz's own cleanups, like Docker's disk image.
fn remeasure(app: &AppHandle, path: &Path) {
    let state = app.state::<AppState>();
    let Some(fresh) = scanner::scan(path, &AtomicBool::new(false), &Progress::default()).ok().flatten() else { return };
    {
        let mut guard = state.result.lock().unwrap();
        let Some(result) = guard.as_mut() else { return };
        let Ok(relative) = path.strip_prefix(&result.root) else { return };
        if result.tree.remove(relative).is_none() || !result.tree.restore(relative, fresh) {
            return;
        }
    }
    save_scan(app);
    app.state::<MenuBar>().refresh_soon();
    let _ = app.emit("scan-updated", ());
}

/// `remeasure` after each delay, in the background.
fn remeasure_after(app: &AppHandle, path: PathBuf, delays: &[Duration]) {
    let (app, delays) = (app.clone(), delays.to_vec());
    thread::spawn(move || {
        let mut waited = Duration::ZERO;
        for delay in delays {
            thread::sleep(delay - waited);
            waited = delay;
            remeasure(&app, &path);
        }
    });
}

/// The size of `path` in the scanned tree, if it's in there.
fn in_tree_size(state: &AppState, path: &Path) -> Option<u64> {
    let guard = state.result.lock().unwrap();
    let result = guard.as_ref()?;
    result.tree.find(path.strip_prefix(&result.root).ok()?).map(|n| n.size)
}

/// Takes `path` out of the scanned tree, returning its size, and keeps it for a later restore.
fn take_from_tree(state: &AppState, path: &Path) -> u64 {
    let mut guard = state.result.lock().unwrap();
    let Some(result) = guard.as_mut() else {
        return 0;
    };
    let Ok(relative) = path.strip_prefix(&result.root) else {
        return 0;
    };
    match result.tree.remove(relative) {
        Some(node) => {
            let size = node.size;
            state.removed.lock().unwrap().insert(path.to_string_lossy().into_owned(), node);
            size
        }
        None => 0,
    }
}

fn put_back_in_tree(state: &AppState, path: &Path) {
    let Some(node) = state.removed.lock().unwrap().remove(&*path.to_string_lossy()) else {
        return;
    };
    let mut guard = state.result.lock().unwrap();
    if let Some(result) = guard.as_mut()
        && let Ok(relative) = path.strip_prefix(&result.root)
    {
        result.tree.restore(relative, node);
    }
}

fn run_cleanup(app: &AppHandle, items: Vec<CleanRequest>, mode: cleanup::Mode) -> Result<CleanReport, String> {
    let state = app.state::<AppState>();
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let total = items.iter().map(|i| i.paths.len()).sum();
    let mut done = 0;
    let mut failed = Vec::new();
    // Per item: label, bytes removed, what was removed.
    let mut results: Vec<(String, u64, Vec<history::Removed>)> = Vec::new();
    // App bundles the user can't remove (installed for all users): (item index, path, size).
    let mut needs_admin: Vec<(usize, PathBuf, u64)> = Vec::new();

    for (index, item) in items.into_iter().enumerate() {
        let (mut size, mut removed) = (0, Vec::new());
        for path in item.paths {
            let _ = app.emit("cleanup-progress", CleanProgress { done, total, current: path.clone() });
            done += 1;
            let p = PathBuf::from(&path);
            let is_app = p.extension().is_some_and(|e| e == "app");
            // App bundles live outside home and get their own checks; everything else must be in home.
            let allowed = if is_app && !p.starts_with(&home) {
                apps::check_removable(&p, &home)
            } else {
                cleanup::check(&p, &home).and_then(|_| if is_app { apps::check_removable(&p, &home) } else { Ok(()) })
            };
            if let Err(error) = allowed {
                failed.push(Failure { path, error });
                continue;
            }
            // Outside the scanned tree (e.g. /Applications), measure before it's gone.
            let outside = in_tree_size(&state, &p).is_none();
            let measured = if outside { apps::size_of(&p) } else { 0 };
            let outcome = match mode {
                cleanup::Mode::Trash => cleanup::move_to_trash(&p).map(Some),
                cleanup::Mode::Delete => cleanup::delete(&p).map(|_| None),
            };
            match outcome {
                Ok(trashed) => {
                    size += if outside { measured } else { take_from_tree(&state, &p) };
                    removed.push(history::Removed {
                        original: path,
                        in_trash: trashed.is_some(),
                        trashed: trashed.map(|t| t.to_string_lossy().into_owned()),
                        restored: false,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && is_app && !p.starts_with(&home) => {
                    needs_admin.push((index, p, measured));
                }
                Err(e) => failed.push(Failure { path, error: e.to_string() }),
            }
        }
        results.push((item.label, size, removed));
    }

    // One password prompt for every app that needs it.
    if !needs_admin.is_empty() {
        let paths: Vec<PathBuf> = needs_admin.iter().map(|(_, p, _)| p.clone()).collect();
        match cleanup::admin_remove(&paths, mode, &home) {
            Ok(destinations) => {
                for ((index, path, size), trashed) in needs_admin.into_iter().zip(destinations) {
                    if fs::symlink_metadata(&path).is_ok() {
                        failed.push(Failure { path: path.to_string_lossy().into_owned(), error: "Still there after removing".into() });
                        continue;
                    }
                    results[index].1 += size;
                    results[index].2.push(history::Removed {
                        original: path.to_string_lossy().into_owned(),
                        in_trash: trashed.is_some(),
                        trashed: trashed.map(|t| t.to_string_lossy().into_owned()),
                        restored: false,
                    });
                }
            }
            Err(e) => {
                for (_, path, _) in needs_admin {
                    failed.push(Failure { path: path.to_string_lossy().into_owned(), error: e.to_string() });
                }
            }
        }
    }

    let cleaned: Vec<history::CleanedItem> = results
        .into_iter()
        .filter(|(_, _, removed)| !removed.is_empty())
        .map(|(label, size, paths)| history::CleanedItem { label, size, paths })
        .collect();
    if !cleaned.is_empty() {
        save_scan(app);
        app.state::<MenuBar>().refresh_soon();
    }
    let cleanup = (!cleaned.is_empty()).then(|| history::Cleanup {
        id: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()),
        at: now(),
        mode,
        items: cleaned,
    });
    if let Some(c) = &cleanup {
        let free = disk::disk_info(&home).map(|d| d.available).ok();
        history::update(&history_path(app)?, |h| {
            h.cleanups.push(c.clone());
            if let Some(free) = free {
                h.sample(now(), free, true);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(CleanReport { freed: cleanup.as_ref().map_or(0, |c| c.freed()), cleanup, failed })
}

/// Removes the given items, one path at a time, reporting `cleanup-progress` events.
#[tauri::command]
async fn clean_up(app: AppHandle, items: Vec<CleanRequest>, mode: cleanup::Mode) -> Result<CleanReport, String> {
    let state = app.state::<AppState>();
    if state.scanning.load(Ordering::SeqCst) {
        return Err("Wait for the scan to finish".into());
    }
    if state.cleaning.swap(true, Ordering::SeqCst) {
        return Err("A cleanup is already running".into());
    }
    let handle = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || run_cleanup(&handle, items, mode)).await;
    app.state::<AppState>().cleaning.store(false, Ordering::SeqCst);
    report.map_err(|e| e.to_string())?
}

/// Moves trashed items of a cleanup back where they were: all of them, or just `paths`.
#[tauri::command]
fn restore_cleanup(app: AppHandle, state: State<AppState>, id: String, paths: Option<Vec<String>>) -> Result<Vec<Failure>, String> {
    history::update(&history_path(&app)?, |all| {
        let cleanup = all.cleanups.iter_mut().find(|c| c.id == id).ok_or("That cleanup isn't in the history")?;
        let mut failed = Vec::new();
        for removed in cleanup.items.iter_mut().flat_map(|i| i.paths.iter_mut()) {
            let wanted = paths.as_ref().is_none_or(|p| p.contains(&removed.original));
            let Some(trashed) = removed.trashed.as_ref().filter(|_| wanted && !removed.restored) else {
                continue;
            };
            let original = PathBuf::from(&removed.original);
            match cleanup::restore(Path::new(trashed), &original) {
                Ok(()) => {
                    removed.restored = true;
                    put_back_in_tree(&state, &original);
                }
                Err(e) => failed.push(Failure { path: removed.original.clone(), error: e.to_string() }),
            }
        }
        Ok(failed)
    })
    .map_err(|e| e.to_string())
    .inspect(|_| {
        save_scan(&app);
        app.state::<MenuBar>().refresh_soon();
    })?
}

/// Deletes for good the items a cleanup moved to the Trash, freeing their space.
/// Only those items: the rest of the Trash is left alone.
#[tauri::command]
fn purge_cleanup(app: AppHandle, id: String) -> Result<Vec<Failure>, String> {
    let trash = app.path().home_dir().map_err(|e| e.to_string())?.join(".Trash");
    history::update(&history_path(&app)?, |all| {
        let cleanup = all.cleanups.iter_mut().find(|c| c.id == id).ok_or("That cleanup isn't in the history")?;
        let mut failed = Vec::new();
        for removed in cleanup.items.iter_mut().flat_map(|i| i.paths.iter_mut()) {
            let Some(trashed) = removed.trashed.clone().filter(|_| !removed.restored) else {
                continue;
            };
            let trashed = PathBuf::from(trashed);
            // Only ever delete inside the Trash.
            if !trashed.starts_with(&trash) {
                failed.push(Failure { path: removed.original.clone(), error: "Not in the Trash".into() });
                continue;
            }
            match cleanup::delete(&trashed) {
                Ok(()) => removed.trashed = None,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => removed.trashed = None,
                Err(e) => failed.push(Failure { path: removed.original.clone(), error: e.to_string() }),
            }
        }
        Ok(failed)
    })
    .map_err(|e| e.to_string())
    .inspect(|_| app.state::<MenuBar>().refresh_soon())?
}

/// The history, with each trashed item checked for whether it's still in the Trash.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppsProgress {
    done: usize,
    total: usize,
    current: String,
}

/// Reads the installed apps in the background, reporting `apps-progress` events.
#[tauri::command]
async fn list_apps(app: AppHandle) -> Result<apps::AppsReport, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        apps::list(&home, |done, total, current| {
            let _ = handle.emit("apps-progress", AppsProgress { done, total, current: current.to_string() });
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// What's inside Docker, read from the Docker API in the background.
#[tauri::command]
async fn docker_report(app: AppHandle) -> Result<docker::Report, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || docker::report(&home)).await.map_err(|e| e.to_string())?
}

/// Measures Docker's disk image again: it changes when Docker frees space, not through Kurz.
#[tauri::command]
fn remeasure_docker_data(app: AppHandle) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    remeasure_after(&app, home.join("Library/Containers/com.docker.docker"), &[Duration::ZERO]);
    Ok(())
}

/// Docker's volumes with their sizes, which take Docker several seconds to measure.
#[tauri::command]
async fn docker_volumes(app: AppHandle) -> Result<Vec<docker::Item>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || docker::volumes_report(&home)).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerRequest {
    kind: docker::Kind,
    id: String,
    label: String,
    size: u64,
}

fn run_docker_cleanup(app: &AppHandle, items: Vec<DockerRequest>) -> Result<CleanReport, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let total = items.len();
    let (mut failed, mut cleaned) = (Vec::new(), Vec::new());
    for (done, item) in items.into_iter().enumerate() {
        let _ = app.emit("cleanup-progress", CleanProgress { done, total, current: item.label.clone() });
        match docker::remove(&home, item.kind, &item.id) {
            Ok(reclaimed) => cleaned.push(history::CleanedItem {
                size: reclaimed.unwrap_or(item.size),
                paths: vec![history::Removed {
                    original: format!("docker:{}", item.id),
                    trashed: None,
                    restored: false,
                    in_trash: false,
                }],
                label: item.label,
            }),
            Err(error) => failed.push(Failure { path: item.label, error }),
        }
    }
    let cleanup = (!cleaned.is_empty()).then(|| history::Cleanup {
        id: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()),
        at: now(),
        // Docker removes for good; there's no Trash for images or volumes.
        mode: cleanup::Mode::Delete,
        items: cleaned,
    });
    if let Some(c) = &cleanup {
        history::update(&history_path(app)?, |h| h.cleanups.push(c.clone())).map_err(|e| e.to_string())?;
        MenuBar::refresh_after(app, &[Duration::from_secs(60), Duration::from_secs(300)]);
        // Docker shrinks its disk image on its own schedule: measure it again a few times.
        let docker_data = home.join("Library/Containers/com.docker.docker");
        remeasure_after(app, docker_data, &[Duration::from_secs(5), Duration::from_secs(60), Duration::from_secs(300)]);
    }
    Ok(CleanReport { freed: cleanup.as_ref().map_or(0, |c| c.freed()), cleanup, failed })
}

/// Removes images, containers, volumes or the build cache through Docker, one at a time.
#[tauri::command]
async fn docker_remove(app: AppHandle, items: Vec<DockerRequest>) -> Result<CleanReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_docker_cleanup(&handle, items)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanInfo {
    root: String,
    scanned_at: i64,
    files: u64,
    dirs: u64,
    errors: u64,
    bytes: u64,
}

/// The scan in memory, if any: from this session or loaded from the last one.
#[tauri::command]
fn scan_info(state: State<AppState>) -> Option<ScanInfo> {
    let guard = state.result.lock().unwrap();
    let r = guard.as_ref()?;
    Some(ScanInfo {
        root: r.root.to_string_lossy().into_owned(),
        scanned_at: r.stats.scanned_at,
        files: r.stats.files,
        dirs: r.stats.dirs,
        errors: r.stats.errors,
        bytes: r.tree.size,
    })
}

#[tauri::command]
fn full_disk_access(app: AppHandle) -> Result<bool, String> {
    Ok(access::has_full_disk_access(&app.path().home_dir().map_err(|e| e.to_string())?))
}

#[tauri::command]
fn open_full_disk_access_settings() -> Result<(), String> {
    access::open_settings().map_err(|e| e.to_string())
}

/// macOS applies a new Full Disk Access grant only after the app restarts.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn get_history(app: AppHandle) -> Result<history::History, String> {
    let mut all = history::load(&history_path(&app)?);
    for removed in all.cleanups.iter_mut().flat_map(|c| c.items.iter_mut()).flat_map(|i| i.paths.iter_mut()) {
        removed.in_trash = !removed.restored && removed.trashed.as_ref().is_some_and(|t| std::fs::symlink_metadata(t).is_ok());
    }
    Ok(all)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle();
            let settings = settings::load(&settings_path(handle)?);
            let home = app.path().home_dir()?;
            app.manage(MenuBar::create(handle, home, history_path(handle)?, settings.menu_bar)?);
            MenuBar::spawn_refresher(handle.clone());
            // Open with the last scan, read in the background; the UI asks for it on `scan-loaded`.
            let app_handle = handle.clone();
            thread::spawn(move || {
                let Some(path) = scan_cache_path(&app_handle) else { return };
                let Some((root, tree, stats)) = cache::load(&path) else { return };
                let state = app_handle.state::<AppState>();
                let mut guard = state.result.lock().unwrap();
                // A scan finished meanwhile is newer; keep it.
                if guard.is_none() && Some(&root) == app_handle.path().home_dir().ok().as_ref() {
                    *guard = Some(ScanResult { root, tree, stats });
                    drop(guard);
                    let _ = app_handle.emit("scan-loaded", ());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // With the menu bar item on, closing the window keeps Kurz running there.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.app_handle().state::<MenuBar>().settings().enabled
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            home_dir,
            disk_info,
            start_scan,
            cancel_scan,
            get_tree,
            get_menu_bar_settings,
            how_it_works,
            get_recommendations,
            clean_up,
            restore_cleanup,
            purge_cleanup,
            get_history,
            full_disk_access,
            list_apps,
            scan_info,
            docker_report,
            docker_volumes,
            remeasure_docker_data,
            docker_remove,
            open_full_disk_access_settings,
            relaunch,
            set_menu_bar_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the Dock icon brings the hidden window back.
            if let RunEvent::Reopen { .. } = event {
                menubar::show_main_window(app);
            }
        });
}
