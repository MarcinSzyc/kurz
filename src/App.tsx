import { useEffect, useRef, useState } from "react";
import {
  cancelScan,
  cleanUp,
  diskInfo,
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
import { GB, sizeOf } from "./lib/tray";
import { CleanUp } from "./components/CleanUp";
import { Explorer, type ExplorerView } from "./components/Explorer";
import { MenuBarSettingsPanel } from "./components/MenuBarSettings";
import { HowItWorks } from "./components/HowItWorks";
import "./fonts.css";
import "./App.css";

/** Levels sent to the map: a folder, its children and grandchildren as tiles inside. */
const MAP_DEPTH = 3;
/** Below this share of the disk free, the free space shows as low. */
const LOW_FREE = 0.1;

type Status = "idle" | "scanning" | "done";
type Page = "cleanup" | "map" | "history" | "how";

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
  const [view, setView] = useState<ExplorerView>("map");
  const [error, setError] = useState<string | null>(null);
  const [menuBar, setMenuBar] = useState<MenuBarSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<Page>("cleanup");

  const [items, setItems] = useState<Recommendation[]>([]);
  const [goal, setGoal] = useState(0);
  const [selection, setSelection] = useState<string[] | null>(null);
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

  useEffect(() => {
    homeDir().then((h) => {
      setHome(h);
      refreshDisk(h);
    }, fail);
    getMenuBarSettings().then(setMenuBar, fail);
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

  async function clean(chosen: Recommendation[], mode: CleanMode) {
    setCleaning({ done: 0, total: chosen.reduce((n, i) => n + i.paths.length, 0) });
    try {
      const result = await cleanUp(
        chosen.map((i) => ({ label: i.label, paths: i.paths })),
        mode,
      );
      setReport(result);
      setSelection([]);
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

  const scanned = status === "done" || (status === "scanning" && done !== null);
  const lowFree = disk ? disk.available / disk.total < LOW_FREE : false;

  return (
    <main className="app">
      <header className="toolbar">
        <div className="title">
          <div>
            <h1>Kurz</h1>
            <p className="muted">{home ?? "Locating home folder…"}</p>
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
          <button className={`ghost ${page === "how" ? "active" : ""}`} onClick={() => setPage(page === "how" ? "cleanup" : "how")}>
            How it works
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)} disabled={!menuBar}>
            Menu bar…
          </button>
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
        </div>
      </header>

      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {page === "how" ? (
        <HowItWorks />
      ) : status === "scanning" || !scanned ? (
        <ScanState status={status} progress={progress} cancelled={!!done?.cancelled} onScan={scan} canScan={!!home} />
      ) : page === "cleanup" ? (
        <CleanUp
          items={items}
          disk={disk}
          selection={selection}
          goal={goal}
          onGoal={(g) => {
            setGoal(g);
            setSelection(null);
          }}
          onSelection={setSelection}
          onClean={clean}
          cleaning={cleaning}
          lastReport={report}
          onUndo={undo}
          onPurge={purge}
          onDismissReport={() => {
            setReport(null);
            setSelection(null);
          }}
        />
      ) : page === "map" && node && done ? (
        <Explorer node={node} root={done.root} view={view} onViewChange={setView} onOpen={open} />
      ) : (
        <section className="card empty-state">
          <h2>History</h2>
          <p className="muted">Free space over time, past cleanups to restore from, and folders that keep growing back. Coming next.</p>
        </section>
      )}

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
