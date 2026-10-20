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

export type MenuBarIcon = "bar" | "tank" | "slabs" | "sprite";

export interface MenuBarSettings {
  enabled: boolean;
  icon: MenuBarIcon;
  text: MenuBarText;
  warnAt: number;
  criticalAt: number;
  refreshMinutes: number;
}

export const getMenuBarSettings = () => invoke<MenuBarSettings>("get_menu_bar_settings");
export const setMenuBarSettings = (settings: MenuBarSettings) =>
  invoke<MenuBarSettings>("set_menu_bar_settings", { settings });
export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> => listen("open-settings", () => cb());

export type Risk = "safe" | "rebuildable" | "takeALook";

export interface RuleInfo {
  id: string;
  label: string;
  risk: Risk;
  matches: string;
  needsIdleProject: boolean;
  reason: string;
  restore: string;
  command: string | null;
}

export interface HowItWorksInfo {
  rules: RuleInfo[];
  never: [string, string][];
  categories: { category: Category; examples: string[] }[];
  idleDays: number;
  maxChildren: number;
  minShare: number;
}

export const howItWorks = () => invoke<HowItWorksInfo>("how_it_works");

export interface Recommendation {
  id: string;
  rule: string;
  label: string;
  risk: Risk;
  category: Category;
  location: string;
  paths: string[];
  size: number;
  modified: number;
  /** What it is, in a sentence. */
  about: string;
  /** The app it belongs to, when Kurz can tell. */
  owner: { name: string; installed: boolean; running: boolean } | null;
}

export type CleanMode = "trash" | "delete";

export interface Removed {
  original: string;
  trashed: string | null;
  restored: boolean;
  inTrash: boolean;
}

export interface Cleanup {
  id: string;
  at: number;
  mode: CleanMode;
  items: { label: string; size: number; paths: Removed[] }[];
}

export interface CleanReport {
  cleanup: Cleanup | null;
  freed: number;
  failed: { path: string; error: string }[];
}

export const getRecommendations = () => invoke<Recommendation[]>("get_recommendations");
export const cleanUp = (items: { label: string; paths: string[] }[], mode: CleanMode) =>
  invoke<CleanReport>("clean_up", { items, mode });
export const restoreCleanup = (id: string, paths?: string[]) =>
  invoke<{ path: string; error: string }[]>("restore_cleanup", { id, paths: paths ?? null });
export interface HistoryData {
  cleanups: Cleanup[];
  samples: { at: number; free: number }[];
  growth: Record<string, { label: string; location: string; sizes: [number, number][] }>;
}

export const getHistory = () => invoke<HistoryData>("get_history");
export const onCleanupProgress = (cb: (p: { done: number; total: number; current: string }) => void): Promise<UnlistenFn> =>
  listen<{ done: number; total: number; current: string }>("cleanup-progress", (e) => cb(e.payload));
export const purgeCleanup = (id: string) => invoke<{ path: string; error: string }[]>("purge_cleanup", { id });

export const fullDiskAccess = () => invoke<boolean>("full_disk_access");
export const openFullDiskAccessSettings = () => invoke<void>("open_full_disk_access_settings");
export const relaunch = () => invoke<void>("relaunch");

export interface AppPart {
  kind: string;
  path: string;
  size: number;
}

export interface InstalledApp {
  id: string;
  name: string;
  version: string | null;
  vendor: string | null;
  category: string | null;
  /** The .app first, then its folders in ~/Library. */
  parts: AppPart[];
  installed: number | null;
  lastOpened: number | null;
  lastOpenedEstimated: boolean;
  running: boolean;
  appStore: boolean;
  ownUninstaller: boolean;
}

export interface Leftover {
  id: string;
  guess: string;
  location: string;
  paths: string[];
  size: number;
  modified: number;
}

export interface AppsReport {
  apps: InstalledApp[];
  leftovers: Leftover[];
  system: string[];
}

export const listApps = () => invoke<AppsReport>("list_apps");
export const onAppsProgress = (cb: (p: { done: number; total: number; current: string }) => void): Promise<UnlistenFn> =>
  listen<{ done: number; total: number; current: string }>("apps-progress", (e) => cb(e.payload));
