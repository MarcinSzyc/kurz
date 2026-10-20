import { useEffect, useState } from "react";
import {
  cancelScan,
  diskInfo,
  getMenuBarSettings,
  getTree,
  homeDir,
  onScanDone,
  onOpenSettings,
  onScanProgress,
  startScan,
  type DiskInfo,
  type MenuBarSettings,
  type ScanDone,
  type ScanProgress,
  type TreeNode,
} from "./lib/api";
import { StatsBar } from "./components/StatsBar";
import { Explorer, type ExplorerView } from "./components/Explorer";
import { MenuBarSettingsPanel } from "./components/MenuBarSettings";
import { HowItWorks } from "./components/HowItWorks";
import "./App.css";

/** Levels sent to the map: a folder, its children and grandchildren as tiles inside. */
const MAP_DEPTH = 3;

type Status = "idle" | "scanning" | "done";
type Page = "disk" | "how";

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
  const [page, setPage] = useState<Page>("disk");

  const fail = (e: unknown) => setError(String(e));

  function refreshDisk(path: string) {
    diskInfo(path).then(setDisk, fail);
  }

  function open(path: string | null) {
    getTree(path, MAP_DEPTH).then(setNode, fail);
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
      onScanDone((d) => {
        setDone(d);
        setProgress(d.progress);
        setStatus(d.cancelled || d.error ? "idle" : "done");
        refreshDisk(d.root);
        if (d.error) setError(d.error);
        if (!d.cancelled && !d.error) open(null);
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  async function scan() {
    if (!home) return;
    setError(null);
    setDone(null);
    setNode(null);
    setProgress(null);
    setStatus("scanning");
    try {
      await startScan(home);
    } catch (e) {
      fail(e);
      setStatus("idle");
    }
  }

  return (
    <main className="app">
      <header className="toolbar">
        <div className="title">
          <div>
            <h1>Kurz</h1>
            <p className="muted">{home ?? "Locating home folder…"}</p>
          </div>
          <div className="segmented">
            <button className={page === "disk" ? "active" : ""} onClick={() => setPage("disk")}>
              Disk
            </button>
            <button className={page === "how" ? "active" : ""} onClick={() => setPage("how")}>
              How it works
            </button>
          </div>
        </div>
        <div className="actions">
          <button onClick={() => setSettingsOpen(true)} disabled={!menuBar}>
            Menu bar…
          </button>
          {status === "scanning" ? (
            <button onClick={() => cancelScan()}>Cancel</button>
          ) : (
            <button className="primary" onClick={scan} disabled={!home}>
              {status === "done" ? "Scan again" : "Scan home folder"}
            </button>
          )}
        </div>
      </header>

      {page === "how" ? (
        <HowItWorks />
      ) : (
        <>
          <StatsBar disk={disk} progress={progress} scanning={status === "scanning"} />

          {error && <p className="error">{error}</p>}
          {done?.cancelled && <p className="muted">Scan cancelled.</p>}

          {node && done ? (
            <Explorer node={node} root={done.root} view={view} onViewChange={setView} onOpen={open} />
          ) : (
            <section className="panel empty">
              <p className="muted">
                {status === "scanning" ? "Scanning… the map appears when the scan finishes." : "Scan your home folder to see what takes up space."}
              </p>
            </section>
          )}
        </>
      )}
      {settingsOpen && menuBar && (
        <MenuBarSettingsPanel initial={menuBar} disk={disk} onClose={() => setSettingsOpen(false)} onSaved={setMenuBar} />
      )}
    </main>
  );
}

export default App;
