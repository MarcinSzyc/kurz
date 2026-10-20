mod categories;
mod disk;
mod gauge;
mod menubar;
pub mod scanner;
mod settings;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
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
}

#[derive(Default)]
struct AppState {
    result: Mutex<Option<ScanResult>>,
    scanning: AtomicBool,
    cancel: Arc<AtomicBool>,
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
                *state.result.lock().unwrap() = Some(ScanResult { root: root.clone(), tree });
                (false, None)
            }
            Ok(None) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        state.scanning.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "scan-done",
            DoneEvent {
                root: root.to_string_lossy().into_owned(),
                cancelled,
                error,
                progress: ProgressEvent::from(&progress, started),
            },
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle();
            let settings = settings::load(&settings_path(handle)?);
            let home = app.path().home_dir()?;
            app.manage(MenuBar::create(handle, home, settings.menu_bar)?);
            MenuBar::spawn_refresher(handle.clone());
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
