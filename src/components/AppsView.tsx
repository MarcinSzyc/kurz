import { useState, type ReactNode } from "react";
import type { AppsReport, InstalledApp } from "../lib/api";
import { formatBytes } from "../lib/format";
import { fromApp, fromLeftover, type TrayEntry } from "../lib/tray";

const DAY = 86_400;
const UNUSED_DAYS = 180;
const LARGE = 1e9;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Category hue and chroma scale, as in design/apps.html. */
const CATEGORY_HUE: Record<string, [number, number]> = {
  "Developer Tools": [295, 1],
  Music: [15, 1],
  Business: [230, 1],
  Productivity: [160, 1],
  "Graphics & Design": [70, 1],
  Utilities: [120, 0.7],
};

type Filter = "all" | "unused" | "large" | "store" | "left";
type Sort = "last" | "size" | "name" | "inst";

interface Props {
  home: string;
  report: AppsReport | null;
  progress: { done: number; total: number; current: string } | null;
  tray: TrayEntry[];
  onToggle: (entry: TrayEntry) => void;
  /** Replaces an app already in the tray, after ticking parts on or off. */
  onUpdate: (entry: TrayEntry) => void;
  trayPanel: ReactNode;
}

const sizeOf = (a: InstalledApp) => a.parts.reduce((s, p) => s + p.size, 0);
const daysSince = (t: number | null) => (t === null ? null : Math.max(0, Math.floor((Date.now() / 1000 - t) / DAY)));
const isUnused = (a: InstalledApp) => {
  const d = daysSince(a.lastOpened);
  return d === null || d >= UNUSED_DAYS;
};

function lastLabel(d: number | null) {
  if (d === null) return "no record";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  if (d < 30) return `${Math.round(d / 7)} wk ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${(d / 365).toFixed(1)} yr ago`;
}

const monthLabel = (t: number | null) => {
  if (t === null) return "—";
  const d = new Date(t * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const initials = (name: string) =>
  name
    .replace(/[^A-Za-z ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || name.slice(0, 1).toUpperCase();

function hue(category: string | null) {
  const [h, k] = CATEGORY_HUE[category ?? ""] ?? [80, 0.15];
  return { "--h": h, "--k": k } as React.CSSProperties;
}

export function AppsView({ home, report, progress, tray, onToggle, onUpdate, trayPanel }: Props) {
  const tilde = (p: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("last");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<string, string[]>>({});
  const [sysOpen, setSysOpen] = useState(false);

  const inTray = (key: string) => tray.some((e) => e.key === key);

  if (!report) {
    return (
      <div className="apps">
        <div className="apps-main">
          <section className="card apps-loading">
            <div className="loading-head">
              <div className="loading-line">
                <span>
                  <b>Reading apps…</b>
                  {progress && progress.total > 0 && (
                    <span className="muted">
                      {" "}
                      {progress.done} of {progress.total}
                    </span>
                  )}
                </span>
                <span className="mono muted small">{progress?.current}</span>
              </div>
              <div className="progress">
                <span style={{ width: `${progress && progress.total ? (progress.done / progress.total) * 100 : 5}%` }} />
              </div>
              <span className="muted small">Sizing each app and matching its folders in ~/Library. Last-opened dates come from Spotlight.</span>
            </div>
            {[180, 140, 200, 120, 160, 150].map((w, i) => (
              <div key={i} className="app-row skeleton" style={{ opacity: 1 - i * 0.13 }}>
                <span className="sk icon" />
                <span className="sk-col">
                  <span className="sk" style={{ width: w, height: 10 }} />
                  <span className="sk" style={{ width: 120, height: 8 }} />
                </span>
                <span className="sk" style={{ width: 90, height: 16 }} />
                <span className="sk" style={{ width: 60, height: 10 }} />
                <span className="sk" style={{ width: 70, height: 10 }} />
              </div>
            ))}
          </section>
        </div>
        {trayPanel}
      </div>
    );
  }

  const { apps, leftovers } = report;
  const unused = apps.filter(isUnused);
  const total = apps.reduce((s, a) => s + sizeOf(a), 0);
  const leftTotal = leftovers.reduce((s, l) => s + l.size, 0);
  const query = q.trim().toLowerCase();

  let list = apps.filter((a) => !query || `${a.name} ${a.vendor ?? ""} ${a.category ?? "Other"}`.toLowerCase().includes(query));
  if (filter === "unused") list = list.filter(isUnused);
  if (filter === "large") list = list.filter((a) => sizeOf(a) > LARGE);
  if (filter === "store") list = list.filter((a) => a.appStore);
  if (filter === "left") list = [];
  const sorters: Record<Sort, (a: InstalledApp, b: InstalledApp) => number> = {
    last: (a, b) => (a.lastOpened ?? 0) - (b.lastOpened ?? 0),
    size: (a, b) => sizeOf(b) - sizeOf(a),
    name: (a, b) => a.name.localeCompare(b.name),
    inst: (a, b) => (a.installed ?? 0) - (b.installed ?? 0),
  };
  list = [...list].sort(sorters[sort]);

  const filters: [Filter, string, number][] = [
    ["all", "All", apps.length],
    ["unused", "Unused 6+ mo", unused.length],
    ["large", "Large (>1 GB)", apps.filter((a) => sizeOf(a) > LARGE).length],
    ["store", "From App Store", apps.filter((a) => a.appStore).length],
    ["left", "Leftovers only", leftovers.length],
  ];

  function toggleKeep(app: InstalledApp, path: string) {
    const current = keep[app.id] ?? [];
    const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
    setKeep({ ...keep, [app.id]: next });
    if (inTray("app:" + app.id)) onUpdate(fromApp(app, next));
  }

  const showList = filter !== "left";
  const showLeft = filter === "all" || filter === "left";
  const allLeftIn = leftovers.length > 0 && leftovers.every((l) => inTray("left:" + l.id));

  return (
    <div className="apps">
      <div className="apps-main">
        <section className="card stats-row apps-tiles">
          <div>
            <span className="muted small">Apps installed</span>
            <span className="stat-line">
              <strong className="mono">{apps.length}</strong>
              <span className="muted small">+ {report.system.length} part of macOS</span>
            </span>
          </div>
          <div>
            <span className="muted small">Total size</span>
            <span className="stat-line">
              <strong className="mono">{formatBytes(total)}</strong>
              <span className="muted small">apps + their data</span>
            </span>
          </div>
          <button className="tile-btn" onClick={() => (setFilter("unused"), setQ(""))}>
            <span className="muted small">Not opened in 6 months</span>
            <span className="stat-line">
              <strong className="mono short">{unused.length} apps</strong>
              <span className="muted small">{formatBytes(unused.reduce((s, a) => s + sizeOf(a), 0))}</span>
            </span>
          </button>
          <button className="tile-btn" onClick={() => (setFilter("left"), setQ(""))}>
            <span className="muted small">Leftovers of removed apps</span>
            <span className="stat-line">
              <strong className="mono good">{formatBytes(leftTotal)}</strong>
              <span className="muted small">{leftovers.length} apps gone</span>
            </span>
          </button>
        </section>

        <div className="apps-controls">
          <label className="search">
            <i />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, vendors, categories" />
            {q && (
              <button className="x" onClick={() => setQ("")} aria-label="Clear search">
                ×
              </button>
            )}
          </label>
          <div className="filter-chips">
            {filters.map(([k, label, count]) => (
              <button key={k} className={`fchip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {label}
                <span className="mono">{count}</span>
              </button>
            ))}
          </div>
          <div className="sort">
            Sort
            <div className="segmented">
              {(
                [
                  ["last", "Last opened"],
                  ["size", "Size"],
                  ["name", "Name"],
                  ["inst", "Installed"],
                ] as [Sort, string][]
              ).map(([k, label]) => (
                <button key={k} className={sort === k ? "active" : ""} onClick={() => setSort(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {showList && (
          <section className="card app-list">
            <div className="app-row head">
              <span />
              <span>App</span>
              <span>Category</span>
              <span>Size</span>
              <span>Installed</span>
              <span>Last opened</span>
              <span />
            </div>
            {list.map((a) => {
              const key = "app:" + a.id;
              const on = inTray(key);
              const open = expanded === a.id;
              const days = daysSince(a.lastOpened);
              const kept = keep[a.id] ?? [];
              const appSize = a.parts[0]?.size ?? 0;
              const leftSize = sizeOf(a) - appSize;
              const freed = a.parts.filter((p, i) => i === 0 || !kept.includes(p.path)).reduce((s, p) => s + p.size, 0);
              return (
                <div key={a.id} className={`app-item ${on ? "on" : ""}`}>
                  <div className="app-row" onClick={() => setExpanded(open ? null : a.id)}>
                    <span className="app-icon-tile" style={hue(a.category)}>
                      {initials(a.name)}
                    </span>
                    <div className="app-name">
                      <div className="app-name-line">
                        <strong>{a.name}</strong>
                        {a.version && <span className="mono muted">{a.version}</span>}
                        {a.vendor && <span className="muted vendor">{a.vendor}</span>}
                      </div>
                      <div className="app-tags">
                        {a.running && (
                          <span className="tag ok">
                            <i className="tag-dot" />
                            Running
                          </span>
                        )}
                        {a.appStore && <span className="tag plain">App Store</span>}
                        {isUnused(a) && <span className="tag coral">{a.lastOpened === null ? "No record of use" : "Not opened in 6+ months"}</span>}
                      </div>
                    </div>
                    <span className="cat-chip" style={hue(a.category)}>
                      {a.category ?? "Other"}
                    </span>
                    <div className="app-size">
                      <span className="mono">{formatBytes(appSize)}</span>
                      {leftSize >= 50e6 && <span className="mono muted">+ {formatBytes(leftSize)} leftovers</span>}
                    </div>
                    <span className="small sub">{monthLabel(a.installed)}</span>
                    <span
                      className={`small ${isUnused(a) ? "short strong" : "sub"}`}
                      title={a.lastOpenedEstimated ? "Spotlight has no record; this is when its data last changed" : undefined}
                    >
                      {a.lastOpenedEstimated ? "~" : ""}
                      {lastLabel(days)}
                    </span>
                    <button
                      className={`tray-btn ${on ? "on" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(fromApp(a, kept));
                      }}
                    >
                      {on ? "✓ In tray" : "+ Uninstall"}
                    </button>
                  </div>
                  {open && (
                    <div className="app-detail">
                      <div className="detail-head">
                        <strong>Uninstall removes</strong>
                        <span className="muted small">Untick anything you want to keep</span>
                      </div>
                      <div className="parts">
                        {a.parts.map((p, i) => {
                          const included = i === 0 || !kept.includes(p.path);
                          return (
                            <label key={p.path} className={`part ${included ? "" : "off"} ${i === 0 ? "locked" : ""}`}>
                              <input type="checkbox" checked={included} disabled={i === 0} onChange={() => toggleKeep(a, p.path)} />
                              <i />
                              <span>{p.kind}</span>
                              <span className="mono sub" title={p.path}>
                                {tilde(p.path)}
                              </span>
                              <span className="mono">{formatBytes(p.size)}</span>
                            </label>
                          );
                        })}
                      </div>
                      {a.running && <p className="note warn">Quit {a.name} first. Kurz will ask it to quit before removing anything.</p>}
                      {a.ownUninstaller && (
                        <p className="note warn">
                          {a.name} has its own uninstaller. Kurz removes the app and its leftovers, but the vendor’s uninstaller also cleans up helpers and
                          login items.
                        </p>
                      )}
                      {a.appStore && <p className="note plain">From the App Store: you can download it again for free.</p>}
                      <div className="detail-foot">
                        <span className="small sub">
                          Frees <b className="mono">{formatBytes(freed)}</b> of {formatBytes(sizeOf(a))}
                        </span>
                        <button className={on ? "" : "cta"} onClick={() => onToggle(fromApp(a, kept))}>
                          {on ? "Remove from tray" : `Add to tray · ${formatBytes(freed)}`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {list.length === 0 && (
              <div className="apps-empty">
                <strong>{query ? `No apps match “${q}”` : "No apps match these filters"}</strong>
                <span className="muted">Search looks at name, vendor and category. System apps aren’t listed.</span>
                <button onClick={() => (setQ(""), setFilter("all"))}>Clear search and filters</button>
              </div>
            )}
            <button className="system-row" onClick={() => setSysOpen(!sysOpen)}>
              <span className="app-icon-tile os">OS</span>
              <div>
                <strong>Part of macOS · {report.system.length} apps</strong>
                <span className="muted small">
                  {report.system.slice(0, 4).join(", ")}… Apple keeps these on a sealed system volume, so they can’t be uninstalled and aren’t
                  counted.
                </span>
              </div>
              <span className="muted small">{sysOpen ? "Hide" : "Show"}</span>
            </button>
            {sysOpen && (
              <div className="system-chips">
                {report.system.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            )}
          </section>
        )}

        {showLeft && (
          <section className={`card leftovers ${filter === "left" ? "focus" : ""}`}>
            <header className="group-head left-head">
              <div>
                <div className="group-title">
                  <span>Leftovers only</span>
                  <span className="mono muted">{formatBytes(leftTotal)}</span>
                </div>
                <span className="group-desc">Data in ~/Library from apps that are no longer installed. Nothing uses it, so it’s safe to remove.</span>
              </div>
              {leftovers.length > 0 && (
                <button
                  className="small-btn"
                  onClick={() =>
                    leftovers.forEach((l) => {
                      if (inTray("left:" + l.id) === allLeftIn) onToggle(fromLeftover(l));
                    })
                  }
                >
                  {allLeftIn ? "Remove all" : "Add all to tray"}
                </button>
              )}
            </header>
            {leftovers.length === 0 && <p className="muted pad">No leftovers found: every app with data in ~/Library is still installed.</p>}
            {leftovers.map((l) => {
              const on = inTray("left:" + l.id);
              return (
                <div key={l.id} className={`left-row ${on ? "on" : ""}`}>
                  <span className="app-icon-tile ghost" />
                  <div className="app-name">
                    <span className="mono">{l.id}</span>
                    <span className="muted small">
                      probably {l.guess} · {l.location}
                    </span>
                  </div>
                  <span className="mono strong">{formatBytes(l.size)}</span>
                  <span className="small sub">changed {lastLabel(daysSince(l.modified))}</span>
                  <button className={`tray-btn ${on ? "on" : ""}`} onClick={() => onToggle(fromLeftover(l))}>
                    {on ? "✓ In tray" : "+ Add"}
                  </button>
                </div>
              );
            })}
          </section>
        )}
      </div>
      {trayPanel}
    </div>
  );
}
