import { useEffect, useState } from "react";
import {
  cancelScan,
  getTree,
  homeDir,
  onScanDone,
  onScanProgress,
  startScan,
  type ScanDone,
  type ScanProgress,
  type TreeNode,
} from "./lib/api";
import { formatBytes, formatCount, formatDuration } from "./lib/format";
import "./App.css";

type Status = "idle" | "scanning" | "done";

function App() {
  const [home, setHome] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [done, setDone] = useState<ScanDone | null>(null);
  const [node, setNode] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    homeDir().then(setHome, (e) => setError(String(e)));
    const unlisten = [
      onScanProgress(setProgress),
      onScanDone((d) => {
        setDone(d);
        setProgress(d.progress);
        setStatus(d.cancelled || d.error ? "idle" : "done");
        if (d.error) setError(d.error);
        if (!d.cancelled && !d.error) open(null);
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  function open(path: string | null) {
    getTree(path, 1).then(setNode, (e) => setError(String(e)));
  }

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
      setError(String(e));
      setStatus("idle");
    }
  }

  return (
    <main className="app">
      <header className="toolbar">
        <div>
          <h1>Kurz</h1>
          <p className="muted">{home ? `Scanning ${home}` : "Locating home folder…"}</p>
        </div>
        {status === "scanning" ? (
          <button onClick={() => cancelScan()}>Cancel</button>
        ) : (
          <button className="primary" onClick={scan} disabled={!home}>
            {status === "done" ? "Scan again" : "Scan home folder"}
          </button>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      {progress && (
        <section className="stats">
          <Stat label={status === "scanning" ? "Scanned so far" : "Total size"} value={formatBytes(progress.bytes)} />
          <Stat label="Files" value={formatCount(progress.files)} />
          <Stat label="Folders" value={formatCount(progress.dirs)} />
          <Stat label="Unreadable" value={formatCount(progress.errors)} />
          <Stat label="Time" value={formatDuration(progress.elapsedMs)} />
        </section>
      )}

      {done?.cancelled && <p className="muted">Scan cancelled.</p>}

      {node && done && <Listing node={node} root={done.root} onOpen={open} />}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Listing({ node, root, onOpen }: { node: TreeNode; root: string; onOpen: (path: string | null) => void }) {
  const relative = node.path.slice(root.length).split("/").filter(Boolean);
  const largest = node.children?.[0]?.size || 1;

  return (
    <section className="panel">
      <nav className="crumbs">
        <button className="link" onClick={() => onOpen(null)}>~</button>
        {relative.map((part, i) => (
          <span key={i}>
            <span className="muted"> / </span>
            <button className="link" onClick={() => onOpen(root + "/" + relative.slice(0, i + 1).join("/"))}>
              {part}
            </button>
          </span>
        ))}
        <span className="size">{formatBytes(node.size)}</span>
      </nav>
      <ul className="rows">
        {(node.children ?? []).map((child) => {
          const canOpen = child.kind === "dir" && child.files > 0;
          return (
            <li key={child.path + child.name}>
              <button className="row" disabled={!canOpen} onClick={() => onOpen(child.path)}>
                <span className="name">
                  {child.kind === "dir" ? "📁" : child.kind === "rest" ? "…" : "📄"} {child.name}
                </span>
                <span className="bar">
                  <span style={{ width: `${(child.size / largest) * 100}%` }} />
                </span>
                <span className="size">{formatBytes(child.size)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default App;
