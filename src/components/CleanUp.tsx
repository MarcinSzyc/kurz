import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Recommendation, Risk } from "../lib/api";
import { formatBytes } from "../lib/format";
import { GB, KIND_HUES, RISKS, ago, items as itemsLabel, sizeOf } from "../lib/tray";

type Filter = "all" | Risk;
type Sort = "size" | "oldest" | "risk" | "name";

const RANK: Record<Risk, number> = { safe: 0, rebuildable: 1, takeALook: 2 };

const SORTERS: Record<Sort, (a: Recommendation, b: Recommendation) => number> = {
  size: (a, b) => b.size - a.size,
  oldest: (a, b) => a.modified - b.modified,
  risk: (a, b) => RANK[a.risk] - RANK[b.risk] || b.size - a.size,
  name: (a, b) => a.label.localeCompare(b.label),
};

/** One row whose button opens a breakdown instead of adding it whole, i.e. Docker. */
export interface Breakdown {
  rule: string;
  /** False when the breakdown can't be had (Docker isn't running): the row adds as a whole. */
  available: boolean;
  /** Size of the pieces in the tray. */
  picked: number;
  /** "In tray: 3 images, 6 containers", or null with nothing picked. */
  summary: string | null;
  /** "12.3 GB unused of 30.0 GB" under the size, once known. */
  sub: string | null;
  onOpen: () => void;
  render: (close: () => void) => ReactNode;
}

interface Props {
  items: Recommendation[];
  /** Ids of the recommendations in the tray. */
  selected: string[];
  goal: number;
  maxGb: number;
  onGoal: (gb: number) => void;
  onToggle: (id: string) => void;
  onSetMany: (ids: string[], inTray: boolean) => void;
  onShowInFinder: (path: string) => void;
  onShowOnMap: (item: Recommendation) => void;
  tray: ReactNode;
  breakdown?: Breakdown;
}

export function CleanUp(props: Props) {
  const { items, selected, goal, maxGb, breakdown } = props;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("size");
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Risk[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [inside, setInside] = useState(false);
  const largest = Math.max(1, ...items.map((i) => i.size));

  const marks = useMemo(() => {
    const safe = sizeOf(items, "safe");
    const rebuild = safe + sizeOf(items, "rebuildable");
    return [
      { pct: (safe / GB / maxGb) * 100, label: `safe only · ${Math.round(safe / GB)} GB` },
      { pct: (rebuild / GB / maxGb) * 100, label: `+ rebuildable · ${Math.round(rebuild / GB)} GB` },
    ].filter((m) => m.pct > 0);
  }, [items, maxGb]);

  const query = q.trim().toLowerCase();
  const list = items
    .filter((i) => filter === "all" || i.risk === filter)
    .filter((i) => !query || [i.label, i.location, i.owner?.name ?? "", i.kind, ...i.paths].join(" ").toLowerCase().includes(query))
    .sort(SORTERS[sort]);
  const isBreakdown = (i: Recommendation) => !!breakdown?.available && breakdown.rule === i.rule;

  const row = (item: Recommendation) => {
    const on = selected.includes(item.id);
    const open = expanded === item.id;
    const pieces = isBreakdown(item);
    const panel = pieces && inside;
    const hue = KIND_HUES[item.kind] ?? 80;
    const picked = pieces ? breakdown!.picked > 0 : on;
    return (
      <div key={item.id} className={`cu-item ${picked ? "on" : ""}`}>
        <div className="cu-row" onClick={() => setExpanded(open ? null : item.id)}>
          <div className="cu-name">
            <span className="cu-chev">{open || panel ? "▾" : "▸"}</span>
            <div>
              <div className="cu-title">
                <span>{item.label}</span>
                {item.owner?.running && <span className="tag warn">Quit {item.owner.name} first</span>}
                {item.owner && !item.owner.installed && <span className="tag ok">App not installed</span>}
              </div>
              <span className="mono muted" title={item.paths.join("\n")}>
                {item.location}
              </span>
            </div>
          </div>
          <span className="cu-kind" style={{ "--h": hue } as CSSProperties}>
            {item.kind}
          </span>
          <span className={`badge small risk-${item.risk}`}>{RISKS.find((r) => r.id === item.risk)?.badge}</span>
          <span className="cu-changed">{ago(item.modified)}</span>
          <div className="cu-size">
            <span className="mono">{formatBytes(item.size)}</span>
            {pieces && breakdown!.sub && <span className="cu-sub">{breakdown!.sub}</span>}
            <span className={`cu-bar risk-${item.risk}`}>
              <span style={{ width: `${Math.max(3, Math.sqrt(item.size / largest) * 100)}%` }} />
            </span>
          </div>
          <button
            className={`tray-btn ${picked && !panel ? "on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!pieces) return props.onToggle(item.id);
              if (!inside) breakdown!.onOpen();
              setInside(!inside);
            }}
          >
            {pieces ? (panel ? "Done ▴" : picked ? `✓ ${formatBytes(breakdown!.picked)} ▾` : "Choose ▾") : on ? "✓ In tray" : "+ Add"}
          </button>
        </div>
        {open && (
          <div className="cu-details">
            <div>
              <span className="cu-label">What it is</span>
              <span>{item.about}</span>
            </div>
            <div>
              <span className="cu-label">After removal</span>
              <span>{item.after}</span>
            </div>
            <div className="cu-actions">
              <button className="small-btn" onClick={() => props.onShowInFinder(item.paths[0])}>
                Show in Finder
              </button>
              <button className="small-btn" onClick={() => props.onShowOnMap(item)}>
                Show on Map
              </button>
              <span className="mono muted">{item.paths.length > 1 ? `${item.paths.length} folders · ${item.location}` : item.location}</span>
            </div>
          </div>
        )}
        {pieces && !panel && breakdown!.summary && (
          <button className="cu-summary" onClick={() => setInside(true)}>
            <span>{breakdown!.summary}</span>
            <span className="good">Change</span>
          </button>
        )}
        {panel && breakdown!.render(() => setInside(false))}
      </div>
    );
  };

  const filters: [Filter, string][] = [
    ["all", "All"],
    ["safe", "Safe"],
    ["rebuildable", "Rebuildable"],
    ["takeALook", "Take a look"],
  ];

  return (
    <div className="cleanup">
      <div className="cleanup-main">
        <section className="card goal">
          <div className="goal-value">
            <span className="muted">I need</span>
            <strong>{goal} GB</strong>
          </div>
          <div className="goal-slider">
            <input type="range" min={0} max={maxGb} step={1} value={Math.min(goal, maxGb)} onChange={(e) => props.onGoal(Number(e.target.value))} />
            {marks.map((m) => (
              <div key={m.label} className={`goal-mark ${m.pct > 80 ? "end" : ""}`} style={{ left: `${m.pct}%` }}>
                <span />
                {m.label}
              </div>
            ))}
          </div>
          <span className="muted goal-hint">Fills the tray with the safest items first</span>
        </section>

        <div className="apps-controls">
          <label className="search">
            <i />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, app or path" />
            {q && (
              <button className="x" onClick={() => setQ("")} aria-label="Clear search">
                ×
              </button>
            )}
          </label>
          <div className="filter-chips">
            {filters.map(([k, label]) => (
              <button key={k} className={`fchip ${filter === k ? "on" : ""} ${k !== "all" ? `risk-${k}` : ""}`} onClick={() => setFilter(k)}>
                {k !== "all" && <i className="fchip-dot" />}
                {label}
                <span className="mono">{formatBytes(sizeOf(items, k === "all" ? undefined : k))}</span>
              </button>
            ))}
          </div>
          <div className="sort">
            Sort
            <div className="segmented">
              {(
                [
                  ["size", "Size"],
                  ["oldest", "Oldest"],
                  ["risk", "Risk"],
                  ["name", "Name"],
                ] as [Sort, string][]
              ).map(([k, label]) => (
                <button key={k} className={sort === k ? "active" : ""} onClick={() => setSort(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <section className="card cu-table">
          <div className="cu-row head">
            <span>Item</span>
            <span>What it is</span>
            <span>Risk</span>
            <span>Changed</span>
            <span className="right">Size</span>
            <label className="cu-groups" title="Group by risk">
              Groups
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              <i />
            </label>
          </div>

          {grouped
            ? RISKS.map((risk) => {
                const group = list.filter((i) => i.risk === risk.id);
                if (!group.length) return null;
                const shut = collapsed.includes(risk.id);
                const plain = group.filter((i) => !isBreakdown(i)).map((i) => i.id);
                const allIn = plain.length > 0 && plain.every((id) => selected.includes(id));
                return (
                  <Fragment key={risk.id}>
                    <div className={`cu-group risk-${risk.id}`}>
                      <div className="cu-group-title">
                        <i className="dot" />
                        <strong>{risk.title}</strong>
                        <span className="mono">
                          {formatBytes(sizeOf(group))} · {itemsLabel(group.length)}
                        </span>
                        <span className="cu-group-desc">{risk.desc}</span>
                      </div>
                      {plain.length > 0 && (
                        <button className="small-btn" onClick={() => props.onSetMany(plain, !allIn)}>
                          {allIn ? "Remove all" : "Add all"}
                        </button>
                      )}
                      <button
                        className="cu-collapse"
                        aria-label={shut ? `Show ${risk.title}` : `Hide ${risk.title}`}
                        onClick={() => setCollapsed(shut ? collapsed.filter((c) => c !== risk.id) : [...collapsed, risk.id])}
                      >
                        {shut ? "▸" : "▾"}
                      </button>
                    </div>
                    {!shut && group.map(row)}
                  </Fragment>
                );
              })
            : list.map(row)}

          {items.length === 0 ? (
            <div className="cu-empty">
              <strong>Nothing to recommend</strong>
              <span className="muted">No caches, build output or idle projects big enough to matter. Nice and tidy.</span>
            </div>
          ) : (
            list.length === 0 && (
              <div className="cu-empty">
                <strong>Nothing matches “{q || RISKS.find((r) => r.id === filter)?.badge}”</strong>
                <span className="muted">Search looks at the name, the app it belongs to and the path.</span>
                <button
                  onClick={() => {
                    setQ("");
                    setFilter("all");
                  }}
                >
                  Clear search and filters
                </button>
              </div>
            )
          )}

          <div className="cu-foot">
            <span>
              {list.length} of {itemsLabel(items.length)}
            </span>
            <span className="mono">{formatBytes(sizeOf(list))}</span>
          </div>
        </section>
      </div>
      {props.tray}
    </div>
  );
}
