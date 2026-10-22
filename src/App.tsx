import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  cancelScan,
  cleanUp,
  diskInfo,
  dockerRemove,
  dockerReport,
  dockerVolumes,
  fullDiskAccess,
  getMenuBarSettings,
  listApps,
  onAppsProgress,
  getRecommendations,
  getTree,
  homeDir,
  onCleanupProgress,
  onOpenSettings,
  onScanDone,
  onScanLoaded,
  onScanUpdated,
  remeasureDockerData,
  onScanProgress,
  purgeCleanup,
  restoreCleanup,
  scanInfo,
  startScan,
  type AppsReport,
  type DockerItem,
  type DockerReport,
  type CleanMode,
  type CleanReport,
  type DiskInfo,
  type MenuBarSettings,
  type Recommendation,
  type ScanDone,
  type ScanProgress,
  type TreeNode,
} from "./lib/api";
import { formatBytes, formatCount, formatDuration } from "./lib/format";
import { GB, addEntry, autoPick, covers, fromFolder, fromRecommendation, sizeOf, type TrayEntry } from "./lib/tray";
import { CleanUp } from "./components/CleanUp";
import { MapView } from "./components/MapView";
import { Tray } from "./components/Tray";
import { MenuBarSettingsPanel } from "./components/MenuBarSettings";
import { HowItWorks } from "./components/HowItWorks";
import { HistoryView } from "./components/HistoryView";
import { FullDiskAccess } from "./components/FullDiskAccess";
import { AppsView } from "./components/AppsView";
import { DockerPanel } from "./components/DockerPanel";
import { MoreMenu, ThemeToggle, type Theme } from "./components/HeaderMenu";
import icon from "./assets/icon.png";
import "./fonts.css";
import "./App.css";

/** Levels sent to the map: a folder's children, and their children shown inside the big ones. */
const MAP_DEPTH = 2;
/** Below this share of the disk free, the free space shows as low. */
const LOW_FREE = 0.1;

type Status = "idle" | "scanning" | "done";
type Page = "cleanup" | "map" | "history" | "apps";

/** A per-device preference, so the browser's storage is enough; it may be unavailable. */
function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("kurz.theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

const TABS: { id: Page; label: string }[] = [
  { id: "cleanup", label: "Clean up" },
  { id: "map", label: "Map" },
  { id: "history", label: "History" },
  { id: "apps", label: "Apps" },
];

function App() {
  const [home, setHome] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [done, setDone] = useState<ScanDone | null>(null);
  const [node, setNode] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuBar, setMenuBar] = useState<MenuBarSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  /** null until checked; the start screen asks for it once, the banner after a scan. */
  const [fda, setFda] = useState<boolean | null>(null);
  const [fdaSkipped, setFdaSkipped] = useState(false);
  const [fdaOpen, setFdaOpen] = useState(false);
  const [appsReport, setAppsReport] = useState<AppsReport | null>(null);
  const [appsProgress, setAppsProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const appsLoading = useRef(false);
  const [docker, setDocker] = useState<DockerReport | null>(null);
  const [dockerVols, setDockerVols] = useState<DockerItem[] | null>(null);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const dockerLoading = useRef(false);
  const [page, setPage] = useState<Page>("cleanup");
  const [theme, setTheme] = useState<Theme>(storedTheme);

  const [items, setItems] = useState<Recommendation[]>([]);
  const [goal, setGoal] = useState(0);
  /** Ids of the recommendations in the tray. Only ever filled by the user, never on its own. */
  const [selection, setSelection] = useState<string[]>([]);
  /** Folders added from the Map, sharing the tray with the recommendations. */
  const [folders, setFolders] = useState<TrayEntry[]>([]);
  const [cleaning, setCleaning] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<CleanReport | null>(null);
  /** When the scan on screen was made (Unix seconds), from this session or the last one. */
  const [scannedAt, setScannedAt] = useState<number | null>(null);

  const fail = (e: unknown) => setError(String(e));

  function refreshDisk(path: string) {
    diskInfo(path).then(setDisk, fail);
  }

  function open(path: string | null) {
    getTree(path, MAP_DEPTH).then(setNode, fail);
  }

  async function refreshRecommendations() {
    const next = await getRecommendations();
    setItems(next);
    return next;
  }

  // The window's appearance drives prefers-color-scheme in the webview, so the CSS needs no changes.
  useEffect(() => {
    try {
      getCurrentWindow()
        .setTheme(theme === "auto" ? null : theme)
        .catch(() => {});
    } catch {
      // Outside the app window (e.g. a plain browser) there's no window to theme.
    }
    try {
      localStorage.setItem("kurz.theme", theme);
    } catch {
      // Not saved; the choice still applies until the app closes.
    }
  }, [theme]);

  /** Shows the scan Kurz already has in memory, e.g. the last one, loaded at launch. */
  async function showSavedScan() {
    const info = await scanInfo().catch(() => null);
    if (!info) return;
    setDone({
      root: info.root,
      cancelled: false,
      error: null,
      progress: { files: info.files, dirs: info.dirs, bytes: info.bytes, errors: info.errors, elapsedMs: 0 },
    });
    setProgress({ files: info.files, dirs: info.dirs, bytes: info.bytes, errors: info.errors, elapsedMs: 0 });
    setScannedAt(info.scannedAt);
    setStatus((s) => (s === "scanning" ? s : "done"));
    open(null);
    refreshRecommendations().catch(fail);
  }

  useEffect(() => {
    homeDir().then((h) => {
      setHome(h);
      refreshDisk(h);
    }, fail);
    getMenuBarSettings().then(setMenuBar, fail);
    fullDiskAccess().then(setFda, () => setFda(false));
    const unlisten = [
      // Listen first, then ask: the saved scan may finish loading at any moment, before or after.
      onScanLoaded(() => showSavedScan()).then((off) => {
        showSavedScan();
        return off;
      }),
      onScanUpdated(() => {
        refreshRecommendations().catch(fail);
        homeDir().then(refreshDisk, () => {});
        setNode((n) => {
          if (n) open(n.path);
          return n;
        });
      }),
      onOpenSettings(() => setSettingsOpen(true)),
      onScanProgress(setProgress),
      onCleanupProgress((p) => setCleaning({ done: p.done, total: p.total })),
      onAppsProgress(setAppsProgress),
      onScanDone((d) => {
        const failed = d.cancelled || !!d.error;
        // A cancelled or failed rescan keeps the scan that was on screen.
        setDone((prev) => (failed && prev && !prev.cancelled && !prev.error ? prev : d));
        if (!failed) setProgress(d.progress);
        setStatus(d.cancelled || d.error ? "idle" : "done");
        refreshDisk(d.root);
        if (d.error) setError(d.error);
        if (!d.cancelled && !d.error) {
          setScannedAt(Date.now() / 1000);
          open(null);
          refreshRecommendations().catch(fail);
        }
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  function loadApps() {
    if (appsLoading.current) return;
    appsLoading.current = true;
    setAppsReport(null);
    listApps()
      .then(setAppsReport, fail)
      .finally(() => {
        appsLoading.current = false;
      });
  }

  useEffect(() => {
    if (page === "apps" && !appsReport) loadApps();
    // Loads once per visit to an empty Apps tab; a cleanup clears it to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, appsReport]);

  async function scan() {
    if (!home) return;
    setError(null);
    setReport(null);
    setStatus("scanning");
    try {
      await startScan(home);
    } catch (e) {
      fail(e);
      setStatus("idle");
    }
  }

  /** Bumped after every change on disk, so screens that load their own data (History) reload. */
  const [syncs, setSyncs] = useState(0);

  /**
   * Brings every screen up to date after anything was removed, restored or emptied from the Trash:
   * recommendations, the map, the disk bar, installed apps, Docker and History.
   */
  async function sync() {
    if (home) refreshDisk(home);
    setAppsReport(null);
    setDocker(null);
    setDockerVols(null);
    setSyncs((n) => n + 1);
    if (node) open(node.path);
    await refreshRecommendations().catch(fail);
  }

  async function clean(chosen: TrayEntry[], mode: CleanMode) {
    const files = chosen.filter((e) => !e.docker);
    const dockerItems = chosen.filter((e) => e.docker);
    setCleaning({ done: 0, total: files.reduce((n, i) => n + i.paths.length, 0) + dockerItems.length });
    try {
      const fileReport = files.length
        ? await cleanUp(
            files.map((i) => ({ label: i.label, paths: i.paths })),
            mode,
          )
        : null;
      const dockerReportResult = dockerItems.length
        ? await dockerRemove(dockerItems.map((e) => ({ kind: e.docker!.kind, id: e.docker!.id, label: e.label, size: e.size })))
        : null;
      // One summary for the tray; Undo applies to the files part, which went to the Trash.
      const parts = [fileReport, dockerReportResult].filter((r): r is CleanReport => r !== null);
      const cleanups = parts.flatMap((r) => (r.cleanup ? [r.cleanup] : []));
      const result: CleanReport = {
        freed: parts.reduce((s, r) => s + r.freed, 0),
        failed: parts.flatMap((r) => r.failed),
        cleanup: cleanups.length ? { ...cleanups[0], items: cleanups.flatMap((c) => c.items) } : null,
      };
      setReport(result);
      setSelection([]);
      setFolders([]);
      await sync();
    } catch (e) {
      fail(e);
    } finally {
      setCleaning(null);
    }
  }

  async function undo() {
    const id = report?.cleanup?.id;
    if (!id) return;
    const failed = await restoreCleanup(id).catch((e) => {
      fail(e);
      return [];
    });
    if (failed.length) setError(`Couldn't restore: ${failed.map((f) => `${f.path} (${f.error})`).join(", ")}`);
    setReport(null);
    setSelection([]);
    await sync();
  }

  async function purge() {
    const cleanup = report?.cleanup;
    if (!report || !cleanup) return;
    const failed = await purgeCleanup(cleanup.id).catch((e) => {
      fail(e);
      return [];
    });
    if (failed.length) setError(`Couldn't delete from Trash: ${failed.map((f) => f.path).join(", ")}`);
    setReport({
      ...report,
      cleanup: { ...cleanup, items: cleanup.items.map((i) => ({ ...i, paths: i.paths.map((p) => ({ ...p, trashed: null })) })) },
    });
    await sync();
  }

  // The tray: recommendations picked by the goal or by hand, plus folders from the Map.
  // A recommendation inside a picked folder is left out so nothing counts twice.
  const selected = selection;
  const hasDockerItems = folders.some((f) => f.docker);
  const recEntries = items
    // Docker's disk image as a whole and pieces of it never both: the pieces win.
    .filter((i) => selected.includes(i.id) && !(hasDockerItems && i.rule === "docker-data"))
    .map(fromRecommendation)
    .filter((e) => !e.paths.every((p) => folders.some((f) => covers(f, p))));
  const tray = [...recEntries, ...folders];
  const maxGb = Math.max(1, Math.ceil(sizeOf(items) / GB));

  function toggleRec(id: string) {
    const adding = !selected.includes(id);
    setSelection(adding ? [...selected, id] : selected.filter((x) => x !== id));
    // Adding all of Docker's data replaces the pieces of it in the tray.
    if (adding && items.find((i) => i.id === id)?.rule === "docker-data") setFolders(folders.filter((f) => !f.docker));
  }

  /** Asks Docker what's inside: the quick part and the volumes, which take longer, side by side. */
  function loadDocker() {
    if (docker || dockerLoading.current) return;
    dockerLoading.current = true;
    setDockerError(null);
    const quick = dockerReport().then(setDocker, (e) => setDockerError(String(e)));
    // The scan's size for Docker's folder goes stale as Docker frees space on its own.
    remeasureDockerData().catch(() => {});
    const vols = dockerVolumes().then(setDockerVols, () => setDockerVols([]));
    Promise.allSettled([quick, vols]).then(() => {
      dockerLoading.current = false;
    });
  }

  // Start asking as soon as Docker shows up in the recommendations, so it's ready when opened.
  const hasDocker = items.some((i) => i.rule === "docker-data");
  useEffect(() => {
    if (hasDocker && !docker) loadDocker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDocker, docker]);

  /** Adds Docker pieces, taking Docker's disk image as a whole out of the tray. */
  function addDocker(entries: TrayEntry[]) {
    const dockerIds = items.filter((i) => i.rule === "docker-data").map((i) => i.id);
    setSelection(selected.filter((id) => !dockerIds.includes(id)));
    setFolders([...folders.filter((f) => !entries.some((e) => e.key === f.key)), ...entries]);
  }
  const setMany = (ids: string[], on: boolean) =>
    setSelection(on ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.includes(x)));

  function removeEntry(key: string) {
    if (folders.some((f) => f.key === key)) setFolders(folders.filter((f) => f.key !== key));
    else setSelection(selected.filter((x) => x !== key));
  }

  /** Adds an app or leftover to the tray (replacing what it contains), or takes it out. */
  function toggleEntry(entry: TrayEntry) {
    if (folders.some((f) => f.key === entry.key)) return removeEntry(entry.key);
    const next = addEntry(folders, selected, items, entry);
    setFolders(next.extras);
    setSelection(next.selected);
  }

  const updateEntry = (entry: TrayEntry) => setFolders(folders.map((f) => (f.key === entry.key ? entry : f)));

  function toggleFolder(n: TreeNode) {
    const holder = tray.find((e) => covers(e, n.path));
    if (holder) return removeEntry(holder.key);
    if (!home) return;
    // The new folder replaces whatever of the tray it contains.
    const next = addEntry(folders, selected, items, fromFolder(n, home, items));
    setFolders(next.extras);
    setSelection(next.selected);
  }

  const trayPanel = (onClean: boolean) => (
    <Tray
      entries={tray}
      goal={onClean ? { gb: goal, maxGb } : undefined}
      disk={disk}
      cleaning={cleaning}
      scanning={status === "scanning"}
      report={report}
      emptyHint={onClean ? "Drag the goal slider or click Add on any item." : "Click a tile to add that folder."}
      onRemove={removeEntry}
      onClear={() => {
        setSelection([]);
        setFolders([]);
      }}
      onClean={clean}
      onUndo={undo}
      onPurge={purge}
      onDismiss={() => {
        setReport(null);
        setSelection([]);
      }}
    />
  );

  // Something is on screen to show: a finished scan, or the one before while a new one runs.
  const scanned = done !== null && !done.cancelled && !done.error;
  const lowFree = disk ? disk.available / disk.total < LOW_FREE : false;

  return (
    <main className="app">
      <header className="toolbar">
        <div className="title">
          <div className="brand">
            <img src={icon} alt="" className="app-icon" />
            <div>
              <h1>Kurz</h1>
              <p className="muted">{home ?? "Locating home folder…"}</p>
            </div>
          </div>
          <nav className="segmented tabs">
            {TABS.map((t) => (
              <button key={t.id} className={page === t.id ? "active" : ""} onClick={() => setPage(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="actions">
          {disk && (
            <div className="diskbar" title={`${formatBytes(disk.used)} of ${formatBytes(disk.total)} used`}>
              <div className="diskbar-label">
                <span className="muted">{disk.name}</span>
                <span className="mono">
                  <b className={lowFree ? "short" : "good"}>{formatBytes(disk.available)}</b> free
                </span>
              </div>
              <div className="diskbar-track">
                <span style={{ width: `${(disk.used / disk.total) * 100}%` }} />
              </div>
            </div>
          )}
          {scanned && (
            <span className="scan-age muted small" title={scannedAt ? new Date(scannedAt * 1000).toLocaleString() : undefined}>
              {status === "scanning" ? `Scanning… ${formatCount(progress?.files ?? 0)} files` : scannedAt ? `scanned ${ageLabel(scannedAt)}` : ""}
            </span>
          )}
          {status === "scanning" ? (
            <button onClick={() => cancelScan()}>Cancel</button>
          ) : (
            <button className={scanned ? "" : "primary"} onClick={scan} disabled={!home || !!cleaning}>
              {scanned ? "Scan again" : "Scan"}
            </button>
          )}
          <ThemeToggle theme={theme} onTheme={setTheme} />
          <MoreMenu theme={theme} onTheme={setTheme} onHowItWorks={() => setHowOpen(true)} onMenuBar={() => setSettingsOpen(true)} />
        </div>
      </header>

      {fda === false && scanned && status === "done" && (progress?.errors ?? 0) > 0 && (
        <div className="banner">
          <span>
            {progress!.errors.toLocaleString("en-US")} folders couldn't be read. Give Kurz Full Disk Access to see everything in ~/Library.
          </span>
          <button onClick={() => setFdaOpen(true)}>Set up</button>
        </div>
      )}

      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {page === "history" ? (
        <HistoryView key={syncs} onError={fail} onChanged={() => sync()} />
      ) : fda === false && !fdaSkipped && !scanned && status !== "scanning" ? (
        <FullDiskAccess onSkip={() => setFdaSkipped(true)} />
      ) : page === "apps" ? (
        <AppsView
          home={home ?? ""}
          report={appsReport}
          progress={appsProgress}
          tray={tray}
          onToggle={toggleEntry}
          onUpdate={updateEntry}
          trayPanel={trayPanel(false)}
        />
      ) : !scanned ? (
        <ScanState status={status} progress={progress} cancelled={!!done?.cancelled} onScan={scan} canScan={!!home} />
      ) : page === "cleanup" ? (
        <CleanUp
          items={items}
          selected={selected}
          goal={goal}
          maxGb={maxGb}
          onGoal={(g) => {
            // Moving the slider is the user asking for this much: pick it once, then it's a plain list.
            setGoal(g);
            setSelection(autoPick(items, g * GB));
          }}
          onToggle={toggleRec}
          onSetMany={setMany}
          tray={trayPanel(true)}
          inside={{
            rule: "docker-data",
            onOpen: loadDocker,
            render: () => (
              <DockerPanel
                report={docker}
                volumes={dockerVols}
                error={dockerError}
                tray={tray}
                onToggle={(e) => (folders.some((f) => f.key === e.key) ? removeEntry(e.key) : addDocker([e]))}
                onAddMany={addDocker}
              />
            ),
          }}
        />
      ) : page === "map" && node && done ? (
        <MapView node={node} root={done.root} items={items} tray={tray} onOpen={open} onToggleFolder={toggleFolder} trayPanel={trayPanel(false)} />
      ) : null}

      {fdaOpen && (
        <FullDiskAccess
          modal
          onSkip={() => {
            setFdaOpen(false);
            fullDiskAccess().then(setFda, () => {});
          }}
        />
      )}
      {howOpen && <HowItWorks onClose={() => setHowOpen(false)} />}
      {settingsOpen && menuBar && (
        <MenuBarSettingsPanel initial={menuBar} disk={disk} onClose={() => setSettingsOpen(false)} onSaved={setMenuBar} />
      )}
    </main>
  );
}

/** "just now", "12 min ago", "3 h ago", "2 days ago" */
function ageLabel(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function ScanState({
  status,
  progress,
  cancelled,
  onScan,
  canScan,
}: {
  status: Status;
  progress: ScanProgress | null;
  cancelled: boolean;
  onScan: () => void;
  canScan: boolean;
}) {
  if (status === "scanning") {
    return (
      <section className="card empty-state">
        <h2>Scanning your home folder…</h2>
        {progress && (
          <div className="scan-stats">
            <div>
              <span className="muted">Scanned</span>
              <strong className="mono">{formatBytes(progress.bytes)}</strong>
            </div>
            <div>
              <span className="muted">Files</span>
              <strong className="mono">{formatCount(progress.files)}</strong>
            </div>
            <div>
              <span className="muted">Folders</span>
              <strong className="mono">{formatCount(progress.dirs)}</strong>
            </div>
            <div>
              <span className="muted">Time</span>
              <strong className="mono">{formatDuration(progress.elapsedMs)}</strong>
            </div>
          </div>
        )}
        <p className="muted">Nothing is changed while scanning. Recommendations appear when it's done.</p>
      </section>
    );
  }
  return (
    <section className="card empty-state">
      <h2>{cancelled ? "Scan cancelled" : "See what's taking up space"}</h2>
      <p className="muted">
        Kurz reads your home folder, then suggests what's safe to remove: caches, build output, idle projects. Nothing is removed until you
        confirm.
      </p>
      <button className="cta" onClick={onScan} disabled={!canScan}>
        Scan home folder
      </button>
    </section>
  );
}

export default App;
