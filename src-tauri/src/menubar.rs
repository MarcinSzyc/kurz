//! The menu bar item: a ring gauge of disk usage with a short label and a menu.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::disk::{self, DiskInfo};
use crate::gauge::{self, Level};
use crate::settings::{MenuBarSettings, MenuBarText};

const TRAY_ID: &str = "main";

pub struct MenuBar {
    tray: TrayIcon,
    info: MenuItem<Wry>,
    home: PathBuf,
    settings: Mutex<MenuBarSettings>,
    /// Set to redraw on the next tick instead of waiting for the refresh interval.
    dirty: AtomicBool,
}

/// Short size for the menu bar: whole numbers from 10 up, one decimal below.
fn short(bytes: u64) -> (f64, &'static str) {
    let gb = bytes as f64 / 1e9;
    if gb >= 1000.0 { (gb / 1000.0, "TB") } else { (gb, "GB") }
}

fn num(value: f64) -> String {
    if value >= 10.0 { format!("{value:.0}") } else { format!("{value:.1}") }
}

pub fn label(text: MenuBarText, disk: &DiskInfo) -> Option<String> {
    let used_percent = disk.used as f64 / disk.total as f64 * 100.0;
    match text {
        MenuBarText::PercentUsed => Some(format!("{used_percent:.0}%")),
        MenuBarText::UsedOfTotal => {
            let (total, unit) = short(disk.total);
            let used = if unit == "TB" { disk.used as f64 / 1e12 } else { disk.used as f64 / 1e9 };
            Some(format!("{}/{} {unit}", num(used), num(total)))
        }
        MenuBarText::Free => {
            let (free, unit) = short(disk.available);
            Some(format!("{} {unit} free", num(free)))
        }
        MenuBarText::None => None,
    }
}

fn summary(disk: &DiskInfo) -> String {
    let (used, used_unit) = short(disk.used);
    let (total, total_unit) = short(disk.total);
    let (free, free_unit) = short(disk.available);
    format!(
        "{}: {} {used_unit} of {} {total_unit} used · {} {free_unit} free",
        disk.name,
        num(used),
        num(total),
        num(free)
    )
}

impl MenuBar {
    pub fn create(app: &AppHandle, home: PathBuf, settings: MenuBarSettings) -> tauri::Result<Self> {
        let info = MenuItem::with_id(app, "info", "Reading disk…", false, None::<&str>)?;
        let open = MenuItem::with_id(app, "open", "Open Kurz", true, None::<&str>)?;
        let configure = MenuItem::with_id(app, "settings", "Menu Bar Settings…", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Kurz", true, Some("CmdOrCtrl+Q"))?;
        let separator = || PredefinedMenuItem::separator(app);
        let menu = Menu::with_items(app, &[&info, &separator()?, &open, &configure, &separator()?, &quit])?;

        let tray = TrayIconBuilder::with_id(TRAY_ID)
            .icon(Image::new_owned(gauge::render(0.0, Level::Normal), gauge::SIZE, gauge::SIZE))
            .icon_as_template(true)
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main_window(app),
                "settings" => {
                    show_main_window(app);
                    let _ = app.emit("open-settings", ());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;

        Ok(Self { tray, info, home, settings: Mutex::new(settings), dirty: AtomicBool::new(true) })
    }

    pub fn settings(&self) -> MenuBarSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn apply(&self, settings: MenuBarSettings) {
        *self.settings.lock().unwrap() = settings;
        self.dirty.store(true, Ordering::Relaxed);
    }

    fn refresh(&self) {
        let settings = self.settings();
        let _ = self.tray.set_visible(settings.enabled);
        if !settings.enabled {
            return;
        }
        let disk = match disk::disk_info(&self.home) {
            Ok(disk) => disk,
            Err(e) => {
                let _ = self.info.set_text(format!("Can't read disk: {e}"));
                return;
            }
        };
        let used_percent = disk.used as f64 / disk.total as f64 * 100.0;
        let level = Level::of(used_percent, settings.warn_at, settings.critical_at);
        let icon = Image::new_owned(gauge::render(used_percent / 100.0, level), gauge::SIZE, gauge::SIZE);

        let _ = self.tray.set_icon_with_as_template(Some(icon), level.is_template());
        let _ = self.tray.set_title(label(settings.text, &disk));
        let _ = self.tray.set_tooltip(Some(summary(&disk)));
        let _ = self.info.set_text(summary(&disk));
    }

    /// Redraws on a timer, and right away after `apply`.
    pub fn spawn_refresher(app: AppHandle) {
        thread::spawn(move || {
            let mut last = Instant::now();
            loop {
                let menu_bar = app.state::<MenuBar>();
                let interval = Duration::from_secs(menu_bar.settings().refresh_minutes as u64 * 60);
                if menu_bar.dirty.swap(false, Ordering::Relaxed) || last.elapsed() >= interval {
                    menu_bar.refresh();
                    last = Instant::now();
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(used: u64, total: u64) -> DiskInfo {
        DiskInfo {
            name: "Macintosh HD".into(),
            mount_point: "/".into(),
            fs_type: "apfs".into(),
            total,
            available: total - used,
            used,
        }
    }

    #[test]
    fn formats_labels() {
        let d = disk(382_400_000_000, 994_700_000_000);
        assert_eq!(label(MenuBarText::PercentUsed, &d).unwrap(), "38%");
        assert_eq!(label(MenuBarText::UsedOfTotal, &d).unwrap(), "382/995 GB");
        assert_eq!(label(MenuBarText::Free, &d).unwrap(), "612 GB free");
        assert_eq!(label(MenuBarText::None, &d), None);
    }

    #[test]
    fn uses_terabytes_for_big_disks() {
        let d = disk(1_500_000_000_000, 2_000_000_000_000);
        assert_eq!(label(MenuBarText::UsedOfTotal, &d).unwrap(), "1.5/2.0 TB");
        assert_eq!(label(MenuBarText::Free, &d).unwrap(), "500 GB free");
    }
}
