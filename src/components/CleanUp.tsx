import { useMemo, useState, type ReactNode } from "react";
import type { Recommendation } from "../lib/api";
import { formatBytes } from "../lib/format";
import { GB, RISKS, ago, sizeOf } from "../lib/tray";

interface Props {
  items: Recommendation[];
  /** Ids of the recommendations in the tray. */
  selected: string[];
  goal: number;
  maxGb: number;
  onGoal: (gb: number) => void;
  onToggle: (id: string) => void;
  onSetMany: (ids: string[], inTray: boolean) => void;
  tray: ReactNode;
  /** A breakdown that opens under one recommendation, e.g. what's inside Docker. */
  inside?: { rule: string; onOpen: () => void; render: () => ReactNode };
}

export function CleanUp({ items, selected, goal, maxGb, onGoal, onToggle, onSetMany, tray, inside }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const largest = Math.max(1, ...items.map((i) => i.size));

  const marks = useMemo(() => {
    const safe = sizeOf(items, "safe");
    const rebuild = safe + sizeOf(items, "rebuildable");
    return [
      { pct: (safe / GB / maxGb) * 100, label: `safe only · ${Math.round(safe / GB)} GB` },
      { pct: (rebuild / GB / maxGb) * 100, label: `+ rebuildable · ${Math.round(rebuild / GB)} GB` },
    ].filter((m) => m.pct > 0);
  }, [items, maxGb]);

  return (
    <div className="cleanup">
      <div className="cleanup-main">
        <section className="card goal">
          <div className="goal-head">
            <div className="goal-value">
              <span className="muted">I need</span>
              <strong>{goal} GB</strong>
            </div>
            <span className="muted small">Kurz fills the tray with the safest items first</span>
          </div>
          <div className="goal-slider">
            <input type="range" min={0} max={maxGb} step={1} value={Math.min(goal, maxGb)} onChange={(e) => onGoal(Number(e.target.value))} />
            {marks.map((m) => (
              <div key={m.label} className={`goal-mark ${m.pct > 80 ? "end" : ""}`} style={{ left: `${m.pct}%` }}>
                <span />
                {m.label}
              </div>
            ))}
          </div>
        </section>

        {items.length === 0 && (
          <section className="card empty-note">
            <p>Nothing to recommend: no caches, build output or idle projects big enough to matter. Nice and tidy.</p>
          </section>
        )}

        {RISKS.map((risk) => {
          const group = items.filter((i) => i.risk === risk.id);
          if (!group.length) return null;
          const ids = group.map((i) => i.id);
          const allIn = ids.every((id) => selected.includes(id));
          return (
            <section key={risk.id} className={`card group risk-${risk.id}`}>
              <header className="group-head">
                <div>
                  <div className="group-title">
                    <span>{risk.title}</span>
                    <span className="mono muted">{formatBytes(sizeOf(group))}</span>
                  </div>
                  <span className="group-desc">{risk.desc}</span>
                </div>
                <button className="small-btn" onClick={() => onSetMany(ids, !allIn)}>
                  {allIn ? "Remove all" : "Add all"}
                </button>
              </header>
              {group.map((item) => {
                const on = selected.includes(item.id);
                return (
                  <div key={item.id} className={`rec-row ${on ? "on" : ""}`}>
                    <span className={`chip cat-${item.category}`} />
                    <div className="rec-name">
                      <span className="rec-title">
                        <span>{item.label}</span>
                        {item.owner?.running && <span className="tag warn">Quit {item.owner.name} first</span>}
                        {item.owner && !item.owner.installed && <span className="tag ok">App not installed</span>}
                      </span>
                      <span className="rec-about" title={item.about}>
                        {item.about}
                      </span>
                      <span className="mono muted" title={item.paths.join("\n")}>
                        {item.location}
                      </span>
                      {inside?.rule === item.rule && (
                        <button
                          className="link inside-toggle"
                          onClick={() => {
                            if (open !== item.id) inside.onOpen();
                            setOpen(open === item.id ? null : item.id);
                          }}
                        >
                          {open === item.id ? "Hide what's inside ▴" : "What's inside ▾"}
                        </button>
                      )}
                    </div>
                    <div className="rec-age">
                      <div className="rec-bar">
                        <span className={`cat-${item.category}`} style={{ width: `${(item.size / largest) * 100}%` }} />
                      </div>
                      <span className="muted">changed {ago(item.modified)}</span>
                    </div>
                    <span className="mono rec-size">{formatBytes(item.size)}</span>
                    <button className={`tray-btn ${on ? "on" : ""}`} onClick={() => onToggle(item.id)}>
                      {on ? "✓ In tray" : "+ Add"}
                    </button>
                    {open === item.id && inside?.rule === item.rule && <div className="rec-inside">{inside.render()}</div>}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      {tray}
    </div>
  );
}
