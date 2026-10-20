import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  cancelScan,
  cleanUp,
  diskInfo,
  fullDiskAccess,
  getMenuBarSettings,
  getRecommendations,
  getTree,
  homeDir,
  onCleanupProgress,
  onOpenSettings,
  onScanDone,
  onScanProgress,
  purgeCleanup,
  restoreCleanup,
  startScan,
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
import { GB, autoPick, covers, fromFolder, fromRecommendation, sizeOf, type TrayEntry } from "./lib/tray";
import { CleanUp } from "./components/CleanUp";
import { MapView } from "./components/MapView";
import { Tray } from "./components/Tray";
import { MenuBarSettingsPanel } from "./components/MenuBarSettings";
import { HowItWorks } from "./components/HowItWorks";
import { HistoryView } from "./components/HistoryView";
import { FullDiskAccess } from "./components/FullDiskAccess";
import { MoreMenu, ThemeToggle, type Theme } from "./components/HeaderMenu";
import icon from "./assets/icon.png";
import "./fonts.css";
import "./App.css";

/** Levels sent to the map: a folder's children, and their children shown inside the big ones. */
const MAP_DEPTH = 2;
/** Below this share of the disk free, the free space shows as low. */
const LOW_FREE = 0.1;

type Status = "idle" | "scanning" | "done";
type Page = "cleanup" | "map" | "history";

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
  const [page, setPage] = useState<Page>("cleanup");
  const [theme, setTheme] = useState<Theme>(storedTheme);

  const [items, setItems] = useState<Recommendation[]>([]);
  const [goal, setGoal] = useState(0);
  const [selection, setSelection] = useState<string[] | null>(null);
  /** Folders added from the Map, sharing the tray with the recommendations. */
  const [folders, setFolders] = useState<TrayEntry[]>([]);
  const [cleaning, setCleaning] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<CleanReport | null>(null);
  const goalSet = useRef(false);

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
    // Start with the safe group in the tray; after that the goal is the user's.
    if (!goalSet.current) {
      // Rounded down, so the default picks only safe items.
      setGoal(Math.floor(sizeOf(next, "safe") / GB));
      goalSet.current = true;
    }
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

  useEffect(() => {
    homeDir().then((h) => {
      setHome(h);
      refreshDisk(h);
    }, fail);
    getMenuBarSettings().then(setMenuBar, fail);
    fullDiskAccess().then(setFda, () => setFda(false));
    const unlisten = [
      onOpenSettings(() => setSettingsOpen(true)),
      onScanProgress(setProgress),
      onCleanupProgress((p) => setCleaning({ done: p.done, total: p.total })),
      onScanDone((d) => {
        setDone(d);
        setProgress(d.progress);
        setStatus(d.cancelled || d.error ? "idle" : "done");
        refreshDisk(d.root);
        if (d.error) setError(d.error);
        if (!d.cancelled && !d.error) {
          open(null);
          refreshRecommendations().catch(fail);
        }
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  async function scan() {
    if (!home) return;
    setError(null);
    setProgress(null);
    setReport(null);
    setStatus("scanning");
    try {
      await startScan(home);
    } catch (e) {
      fail(e);
      setStatus("idle");
    }
  }

  async function clean(chosen: TrayEntry[], mode: CleanMode) {
    setCleaning({ done: 0, total: chosen.reduce((n, i) => n + i.paths.length, 0) });
    try {
      const result = await cleanUp(
        chosen.map((i) => ({ label: i.label, paths: i.paths })),
        mode,
      );
      setReport(result);
      setSelection([]);
      setFolders([]);
      await refreshRecommendations();
      if (home) refreshDisk(home);
      if (node) open(node.path);
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
    setSelection(null);
    await refreshRecommendations().catch(fail);
    if (home) refreshDisk(home);
    if (node) open(node.path);
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
    if (home) refreshDisk(home);
  }

  // The tray: recommendations picked by the goal or by hand, plus folders from the Map.
  // A recommendation inside a picked folder is left out so nothing counts twice.
  const selected = selection ?? autoPick(items, goal * GB);
  const recEntries = items
    .filter((i) => selected.includes(i.id))
    .map(fromRecommendation)
    .filter((e) => !e.paths.every((p) => folders.some((f) => covers(f, p))));
  const tray = [...recEntries, ...folders];
  const maxGb = Math.max(1, Math.ceil(sizeOf(items) / GB));

  const toggleRec = (id: string) => setSelection(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const setMany = (ids: string[], on: boolean) =>
    setSelection(on ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.includes(x)));

  function removeEntry(key: string) {
    if (folders.some((f) => f.key === key)) setFolders(folders.filter((f) => f.key !== key));
    else setSelection(selected.filter((x) => x !== key));
  }

  function toggleFolder(n: TreeNode) {
    const holder = tray.find((e) => covers(e, n.path));
    if (holder) return removeEntry(holder.key);
    if (!home) return;
    const entry = fromFolder(n, home, items);
    // The new folder replaces whatever of the tray it contains.
    setFolders([...folders.filter((f) => !covers(entry, f.paths[0])), entry]);
    setSelection(selected.filter((id) => !items.find((i) => i.id === id)?.paths.every((p) => covers(entry, p))));
  }

  const trayPanel = (onClean: boolean) => (
    <Tray
      entries={tray}
      goal={onClean ? { gb: goal, maxGb } : undefined}
      disk={disk}
      cleaning={cleaning}
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
        setSelection(null);
      }}
    />
  );

  const scanned = status === "done" || (status === "scanning" && done !== null);
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
        <HistoryView
          onError={fail}
          onChanged={() => {
            if (home) refreshDisk(home);
            if (scanned) {
              refreshRecommendations().catch(fail);
              if (node) open(node.path);
            }
          }}
        />
      ) : fda === false && !fdaSkipped && !scanned && status !== "scanning" ? (
        <FullDiskAccess onSkip={() => setFdaSkipped(true)} />
      ) : status === "scanning" || !scanned ? (
        <ScanState status={status} progress={progress} cancelled={!!done?.cancelled} onScan={scan} canScan={!!home} />
      ) : page === "cleanup" ? (
        <CleanUp
          items={items}
          selected={selected}
          goal={goal}
          maxGb={maxGb}
          onGoal={(g) => {
            setGoal(g);
            setSelection(null);
          }}
          onToggle={toggleRec}
          onSetMany={setMany}
          tray={trayPanel(true)}
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
