import { useMemo, useState } from "react";
import type { CleanMode, CleanReport, DiskInfo, Recommendation } from "../lib/api";
import { formatBytes } from "../lib/format";
import { GB, RISKS, ago, autoPick, sizeOf } from "../lib/tray";

interface Props {
  items: Recommendation[];
  disk: DiskInfo | null;
  /** `null` means "follow the goal". */
  selection: string[] | null;
  goal: number;
  onGoal: (gb: number) => void;
  onSelection: (ids: string[]) => void;
  onClean: (items: Recommendation[], mode: CleanMode) => Promise<void>;
  cleaning: { done: number; total: number } | null;
  lastReport: CleanReport | null;
  onUndo: () => void;
  onPurge: () => Promise<void>;
  onDismissReport: () => void;
}

export function CleanUp(props: Props) {
  const { items, disk, goal } = props;
  const selected = props.selection ?? autoPick(items, goal * GB);
  const maxGb = Math.max(1, Math.ceil(sizeOf(items) / GB));
  const largest = Math.max(1, ...items.map((i) => i.size));
  const [sheet, setSheet] = useState(false);

  const toggle = (id: string) =>
    props.onSelection(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

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
            <input type="range" min={0} max={maxGb} step={1} value={Math.min(goal, maxGb)} onChange={(e) => props.onGoal(Number(e.target.value))} />
            {marks.map((m) => (
              <div key={m.label} className="goal-mark" style={{ left: `${m.pct}%` }}>
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
          const allIn = group.every((i) => selected.includes(i.id));
          const ids = group.map((i) => i.id);
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
                <button
                  className="small-btn"
                  onClick={() =>
                    props.onSelection(allIn ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])])
                  }
                >
                  {allIn ? "Remove all" : "Add all"}
                </button>
              </header>
              {group.map((item) => {
                const on = selected.includes(item.id);
                return (
                  <div key={item.id} className={`rec-row ${on ? "on" : ""}`}>
                    <span className={`chip cat-${item.category}`} />
                    <div className="rec-name">
                      <span>{item.label}</span>
                      <span className="mono muted" title={item.paths.join("\n")}>
                        {item.location}
                      </span>
                    </div>
                    <div className="rec-age">
                      <div className="rec-bar">
                        <span className={`cat-${item.category}`} style={{ width: `${(item.size / largest) * 100}%` }} />
                      </div>
                      <span className="muted">changed {ago(item.modified)}</span>
                    </div>
                    <span className="mono rec-size">{formatBytes(item.size)}</span>
                    <button className={`tray-btn ${on ? "on" : ""}`} onClick={() => toggle(item.id)}>
                      {on ? "✓ In tray" : "+ Add"}
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <Tray
        items={items.filter((i) => selected.includes(i.id))}
        goal={goal}
        maxGb={maxGb}
        disk={disk}
        cleaning={props.cleaning}
        report={props.lastReport}
        onRemove={toggle}
        onClear={() => props.onSelection([])}
        onReview={() => setSheet(true)}
        onUndo={props.onUndo}
        onPurge={props.onPurge}
        onDismiss={props.onDismissReport}
      />

      {sheet && (
        <ConfirmSheet
          items={items.filter((i) => selected.includes(i.id))}
          disk={disk}
          onCancel={() => setSheet(false)}
          onConfirm={async (mode) => {
            setSheet(false);
            await props.onClean(
              items.filter((i) => selected.includes(i.id)),
              mode,
            );
          }}
        />
      )}
    </div>
  );
}

interface TrayProps {
  items: Recommendation[];
  goal: number;
  maxGb: number;
  disk: DiskInfo | null;
  cleaning: { done: number; total: number } | null;
  report: CleanReport | null;
  onRemove: (id: string) => void;
  onClear: () => void;
  onReview: () => void;
  onUndo: () => void;
  onPurge: () => Promise<void>;
  onDismiss: () => void;
}

function Tray({ items, goal, maxGb, disk, cleaning, report, onRemove, onClear, onReview, onUndo, onPurge, onDismiss }: TrayProps) {
  const [purgeArmed, setPurgeArmed] = useState(false);
  const total = sizeOf(items);
  const met = total >= goal * GB;
  const sorted = [...items].sort((a, b) => b.size - a.size);
  const empty = items.length === 0;
  const cleanup = report?.cleanup ?? null;
  const inTrash = cleanup?.mode === "trash" && cleanup.items.some((i) => i.paths.some((p) => p.trashed && !p.restored));

  if (cleanup && report) {
    return (
      <aside className="card tray">
        <div className="tray-head">
          <div className="tray-title">
            <span>Cleaned</span>
            <span className="muted small">{cleanup.items.length} items</span>
          </div>
          <strong className="tray-total mono">{formatBytes(report.freed)}</strong>
        </div>
        <div className="tray-list">
          {cleanup.items.map((i) => (
            <div key={i.label} className="tray-row done">
              <span className="tray-name">{i.label}</span>
              <span className="mono small">{formatBytes(i.size)}</span>
            </div>
          ))}
        </div>
        {report.failed.length > 0 && (
          <div className="note warn">
            {report.failed.length} {report.failed.length === 1 ? "path" : "paths"} couldn't be removed:{" "}
            {report.failed.map((f) => `${f.path.split("/").pop()} (${f.error})`).join(", ")}
          </div>
        )}
        <div className="note ok">
          {cleanup.mode === "trash" ? (
            inTrash ? (
              <>
                <span>Moved to Trash · frees {formatBytes(report.freed)} once emptied</span>
                <button className="link strong" onClick={onUndo}>
                  Undo
                </button>
              </>
            ) : (
              <span>{disk ? `${formatBytes(disk.available)} free` : "Done"}</span>
            )
          ) : (
            <span>Deleted · {disk ? `${formatBytes(disk.available)} free` : "done"}</span>
          )}
        </div>
        <div className="tray-actions">
          {inTrash && (
            <button
              className="cta"
              onClick={async () => {
                if (!purgeArmed) return setPurgeArmed(true);
                setPurgeArmed(false);
                await onPurge();
              }}
            >
              {purgeArmed ? `Click again to delete ${formatBytes(report.freed)} for good` : "Empty from Trash · free it for good"}
            </button>
          )}
          <button className="link muted" onClick={onDismiss}>
            Start over
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="card tray">
      <div className="tray-head">
        <div className="tray-title">
          <span>Cleanup tray</span>
          <span className="muted small">{items.length} items</span>
        </div>
        <div className="tray-sum">
          <strong className="tray-total mono">{formatBytes(total)}</strong>
          <span className={`small ${met ? "good" : "short"}`}>
            {goal === 0 ? "no goal set" : met ? `✓ goal of ${goal} GB met` : `${formatBytes(goal * GB - total)} short of goal`}
          </span>
        </div>
        <div className="tray-meter">
          <span style={{ width: `${Math.min(100, (total / GB / maxGb) * 100)}%` }} />
          <i style={{ left: `${Math.min(100, (goal / maxGb) * 100)}%` }} />
        </div>
        {disk && (
          <div className="small muted">
            {formatBytes(disk.available)} free → <b className="good mono">{formatBytes(disk.available + total)}</b> after cleanup
          </div>
        )}
      </div>
      <div className="tray-list">
        {sorted.map((i) => (
          <div key={i.id} className="tray-row">
            <span className={`chip cat-${i.category}`} />
            <span className="tray-name">{i.label}</span>
            <span className={`badge risk-${i.risk}`}>{RISKS.find((r) => r.id === i.risk)?.badge}</span>
            <span className="mono small tray-size">{formatBytes(i.size)}</span>
            <button className="x" onClick={() => onRemove(i.id)} aria-label={`Remove ${i.label} from the tray`}>
              ×
            </button>
          </div>
        ))}
        {empty && <p className="tray-empty muted">Drag the goal slider or click Add on any item.</p>}
        {items.some((i) => i.risk === "takeALook") && (
          <div className="note warn">
            {items.filter((i) => i.risk === "takeALook").length === 1 ? "1 item" : `${items.filter((i) => i.risk === "takeALook").length} items`} may
            contain your own files ({items
              .filter((i) => i.risk === "takeALook")
              .map((i) => i.label)
              .join(", ")}
            ). Kurz asks before removing them.
          </div>
        )}
      </div>
      <div className="tray-actions">
        <button className="cta" disabled={empty || !!cleaning} onClick={onReview}>
          {cleaning ? `Cleaning… ${cleaning.done}/${cleaning.total}` : empty ? "Add items to clean" : `Review & clean ${formatBytes(total)}`}
        </button>
        <button className="link muted" onClick={onClear} disabled={empty}>
          Empty the tray
        </button>
      </div>
    </aside>
  );
}

function ConfirmSheet({
  items,
  disk,
  onCancel,
  onConfirm,
}: {
  items: Recommendation[];
  disk: DiskInfo | null;
  onCancel: () => void;
  onConfirm: (mode: CleanMode) => void;
}) {
  const [mode, setMode] = useState<CleanMode>("trash");
  const total = sizeOf(items);
  const modes: { id: CleanMode; label: string; desc: string }[] = [
    { id: "trash", label: "Move to Trash", desc: "You can restore it until you empty the Trash" },
    { id: "delete", label: "Delete permanently", desc: "Frees the space right away. Can't be undone." },
  ];

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="sheet confirm" role="dialog" aria-label="Confirm cleanup" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-head">
          <h2>Clean {formatBytes(total)}?</h2>
          <p className="muted">
            {items.length} items{disk ? ` · ${formatBytes(disk.available + total)} free afterwards` : ""}
          </p>
        </div>
        <div className="confirm-groups">
          {RISKS.map((risk) => {
            const group = items.filter((i) => i.risk === risk.id);
            if (!group.length) return null;
            return (
              <div key={risk.id} className="confirm-group">
                <span className={`dot risk-${risk.id}`} />
                <div>
                  <strong>
                    {risk.badge} · {group.length}
                  </strong>
                  <span className="muted">
                    {risk.id === "takeALook" ? `${group.map((i) => i.label).join(", ")}. ` : ""}
                    {risk.sheet}
                    {risk.id === "takeALook" && mode === "trash" ? " Moved to Trash, so you can still restore them." : ""}
                  </span>
                </div>
                <span className="mono">{formatBytes(sizeOf(group))}</span>
              </div>
            );
          })}
        </div>
        <div className="confirm-modes">
          {modes.map((m) => (
            <label key={m.id} className={`mode ${mode === m.id ? "on" : ""}`}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <div>
                <strong>{m.label}</strong>
                <span className="muted">{m.desc}</span>
              </div>
            </label>
          ))}
        </div>
        <div className="confirm-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className={`cta ${mode === "delete" ? "danger" : ""}`} onClick={() => onConfirm(mode)} autoFocus>
            {mode === "delete" ? `Delete ${formatBytes(total)}` : "Move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
}
