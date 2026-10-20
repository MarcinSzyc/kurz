import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type NodeKind = "dir" | "file" | "symlink" | "other" | "rest";

export type Category = "media" | "code" | "devTools" | "sdk" | "aiModels" | "cache" | "system" | "other";

export interface TreeNode {
  name: string;
  path: string;
  kind: NodeKind;
  category: Category;
  size: number;
  files: number;
  children: TreeNode[] | null;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  elapsedMs: number;
}

export interface ScanDone {
  root: string;
  cancelled: boolean;
  error: string | null;
  progress: ScanProgress;
}

export const homeDir = () => invoke<string>("home_dir");
export const startScan = (path: string) => invoke<void>("start_scan", { path });
export const cancelScan = () => invoke<void>("cancel_scan");
export const getTree = (path: string | null, depth: number) =>
  invoke<TreeNode>("get_tree", { path, depth });

export const onScanProgress = (cb: (p: ScanProgress) => void): Promise<UnlistenFn> =>
  listen<ScanProgress>("scan-progress", (e) => cb(e.payload));
export const onScanDone = (cb: (d: ScanDone) => void): Promise<UnlistenFn> =>
  listen<ScanDone>("scan-done", (e) => cb(e.payload));

export interface DiskInfo {
  name: string;
  mountPoint: string;
  fsType: string;
  total: number;
  available: number;
  used: number;
}

export const diskInfo = (path: string) => invoke<DiskInfo>("disk_info", { path });

export type MenuBarText = "percentUsed" | "usedOfTotal" | "free" | "none";

export interface MenuBarSettings {
  enabled: boolean;
  text: MenuBarText;
  warnAt: number;
  criticalAt: number;
  refreshMinutes: number;
}

export const getMenuBarSettings = () => invoke<MenuBarSettings>("get_menu_bar_settings");
export const setMenuBarSettings = (settings: MenuBarSettings) =>
  invoke<MenuBarSettings>("set_menu_bar_settings", { settings });
export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> => listen("open-settings", () => cb());
