import { useState } from "react";
import type { CleanMode, CleanReport, DiskInfo } from "../lib/api";
import { formatBytes } from "../lib/format";
import { GB, RISKS, items, type TrayEntry } from "../lib/tray";

const total = (entries: TrayEntry[]) => entries.reduce((sum, e) => sum + e.size, 0);

interface TrayProps {
  entries: TrayEntry[];
  /** Clean up shows progress toward a goal; the Map just says the tray is shared. */
  goal?: { gb: number; maxGb: number };
  disk: DiskInfo | null;
  cleaning: { done: number; total: number } | null;
  report: CleanReport | null;
  emptyHint: string;
  onRemove: (key: string) => void;
  onClear: () => void;
  onClean: (entries: TrayEntry[], mode: CleanMode) => Promise<void>;
  onUndo: () => void;
  onPurge: () => Promise<void>;
  onDismiss: () => void;
}

export function Tray(props: TrayProps) {
  const { entries, goal, disk, cleaning, report } = props;
  const [sheet, setSheet] = useState(false);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const sum = total(entries);
  const sorted = [...entries].sort((a, b) => b.size - a.size);
  const empty = entries.length === 0;
  const own = entries.filter((e) => e.risk === "takeALook");
  const cleanup = report?.cleanup ?? null;
  const inTrash = cleanup?.mode === "trash" && cleanup.items.some((i) => i.paths.some((p) => p.trashed && !p.restored));

  if (cleanup && report) {
    return (
      <aside className="card tray">
        <div className="tray-head">
          <div className="tray-title">
            <span>Cleaned</span>
            <span className="muted small">{items(cleanup.items.length)}</span>
          </div>
          <strong className="tray-total mono">{formatBytes(report.freed)}</strong>
        </div>
        <div className="tray-list">
          {cleanup.items.map((i) => (
            <div key={i.label + i.paths[0]?.original} className="tray-row done">
              <span className="tray-name">{i.label}</span>
              <span className="mono small">{formatBytes(i.size)}</span>
            </div>
          ))}
        </div>
        {report.failed.length > 0 && (
          <div className="note warn">
            {report.failed.length} {report.failed.length === 1 ? "path" : "paths"} couldn't be removed:
            <ul className="fail-list">
              {report.failed.map((f) => (
                <li key={f.path}>
                  <b>{f.path.split("/").pop()}</b> · {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="note ok">
          {cleanup.mode === "trash" && inTrash ? (
            <>
              <span>Moved to Trash · frees {formatBytes(report.freed)} once emptied</span>
              <button className="link strong" onClick={props.onUndo}>
                Undo
              </button>
            </>
          ) : (
            <span>
              {cleanup.mode === "delete" ? "Deleted · " : ""}
              {disk ? `${formatBytes(disk.available)} free` : "Done"}
            </span>
          )}
        </div>
        <div className="tray-actions">
          {inTrash && (
            <button
              className="cta"
              onClick={async () => {
                if (!purgeArmed) return setPurgeArmed(true);
                setPurgeArmed(false);
                await props.onPurge();
              }}
            >
              {purgeArmed ? `Click again to delete ${formatBytes(report.freed)} for good` : "Empty from Trash · free it for good"}
            </button>
          )}
          <button className="link muted" onClick={props.onDismiss}>
            Start over
          </button>
        </div>
      </aside>
    );
  }

  const met = goal ? sum >= goal.gb * GB : false;
  return (
    <aside className="card tray">
      <div className="tray-head">
        <div className="tray-title">
          <span>Cleanup tray</span>
          <span className="muted small">{goal ? items(entries.length) : "shared across tabs"}</span>
        </div>
        <div className="tray-sum">
          <strong className="tray-total mono">{formatBytes(sum)}</strong>
          {goal ? (
            <span className={`small ${met ? "good" : "short"}`}>
              {goal.gb === 0 ? "no goal set" : met ? `✓ goal of ${goal.gb} GB met` : `${formatBytes(goal.gb * GB - sum)} short of goal`}
            </span>
          ) : (
            <span className="small muted">{items(entries.length)}</span>
          )}
        </div>
        {goal ? (
          <div className="tray-meter">
            <span style={{ width: `${Math.min(100, (sum / GB / goal.maxGb) * 100)}%` }} />
            <i style={{ left: `${Math.min(100, (goal.gb / goal.maxGb) * 100)}%` }} />
          </div>
        ) : (
          disk && (
            <div className="tray-disk">
              <span style={{ width: `${((disk.used - sum) / disk.total) * 100}%` }} />
              <i style={{ width: `${(Math.min(sum, disk.used) / disk.total) * 100}%` }} />
            </div>
          )
        )}
        {disk && (
          <div className="small muted">
            {formatBytes(disk.available)} free → <b className="good mono">{formatBytes(disk.available + sum)}</b> after cleanup
          </div>
        )}
      </div>
      <div className="tray-list">
        {sorted.map((e) => (
          <div key={e.key} className={`tray-row ${e.parts ? "with-parts" : ""}`}>
            <span className={`chip cat-${e.category}`} />
            <div className="tray-name">
              <span>{e.label}</span>
              {!goal && <span className="mono muted">{e.location}</span>}
            </div>
            <span className={`badge risk-${e.risk}`}>{RISKS.find((r) => r.id === e.risk)?.badge}</span>
            <span className="mono small tray-size">{formatBytes(e.size)}</span>
            <button className="x" onClick={() => props.onRemove(e.key)} aria-label={`Remove ${e.label} from the tray`}>
              ×
            </button>
            {e.parts && (
              <div className="tray-parts">
                {e.parts.map((p, i) => (
                  <div key={i}>
                    <span>{p.kind}</span>
                    <span className="mono">{formatBytes(p.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {empty && <p className="tray-empty muted">{props.emptyHint}</p>}
        {entries.some((e) => e.key.startsWith("app:")) ? (
          <div className="note warn">
            Apps are marked “Take a look”: their settings and data go too. Untick Preferences in the app’s row to keep your settings.
          </div>
        ) : own.length > 0 && (
          <div className="note warn">
            {own.length === 1 ? "1 item" : `${own.length} items`} may contain your own files ({own.map((e) => e.label).join(", ")}). Kurz asks
            before removing them.
          </div>
        )}
      </div>
      <div className="tray-actions">
        <button className="cta" disabled={empty || !!cleaning} onClick={() => setSheet(true)}>
          {cleaning ? `Cleaning… ${cleaning.done}/${cleaning.total}` : empty ? "Add items to clean" : `Review & clean ${formatBytes(sum)}`}
        </button>
        <button className="link muted" onClick={props.onClear} disabled={empty}>
          Empty the tray
        </button>
      </div>

      {sheet && (
        <ConfirmSheet
          entries={entries}
          disk={disk}
          onCancel={() => setSheet(false)}
          onConfirm={async (mode) => {
            setSheet(false);
            await props.onClean(entries, mode);
          }}
        />
      )}
    </aside>
  );
}

function ConfirmSheet({
  entries,
  disk,
  onCancel,
  onConfirm,
}: {
  entries: TrayEntry[];
  disk: DiskInfo | null;
  onCancel: () => void;
  onConfirm: (mode: CleanMode) => void;
}) {
  const [mode, setMode] = useState<CleanMode>("trash");
  const sum = total(entries);
  const modes: { id: CleanMode; label: string; desc: string }[] = [
    { id: "trash", label: "Move to Trash", desc: "You can restore it until you empty the Trash" },
    { id: "delete", label: "Delete permanently", desc: "Frees the space right away. Can't be undone." },
  ];

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="sheet confirm" role="dialog" aria-label="Confirm cleanup" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-head">
          <h2>Clean {formatBytes(sum)}?</h2>
          <p className="muted">
            {items(entries.length)}
            {disk ? ` · ${formatBytes(disk.available + sum)} free afterwards` : ""}
          </p>
        </div>
        <div className="confirm-groups">
          {RISKS.map((risk) => {
            const group = entries.filter((e) => e.risk === risk.id);
            if (!group.length) return null;
            return (
              <div key={risk.id} className="confirm-group">
                <span className={`dot risk-${risk.id}`} />
                <div>
                  <strong>
                    {risk.badge} · {group.length}
                  </strong>
                  <span className="muted">
                    {risk.id === "takeALook" ? `${group.map((e) => e.label).join(", ")}. ` : ""}
                    {risk.id === "takeALook" && group.some((e) => e.key.startsWith("app:")) ? "Apps and their data; documents you made with them are not touched. " : ""}
                    {risk.sheet}
                    {risk.id === "takeALook" && mode === "trash" ? " Moved to Trash, so you can still restore them." : ""}
                  </span>
                </div>
                <span className="mono">{formatBytes(total(group))}</span>
              </div>
            );
          })}
        </div>
        {entries.some((e) => e.quitsApp) && (
          <p className="note warn sheet-note">Kurz will ask {entries.flatMap((e) => (e.quitsApp ? [e.quitsApp] : [])).join(", ")} to quit first.</p>
        )}
        {entries.flatMap((e) => (e.note ? [e.note] : [])).map((n) => (
          <p key={n} className="note warn sheet-note">
            {n}
          </p>
        ))}
        {entries.some((e) => e.runningApp) && (
          <p className="note warn sheet-note">
            Quit {[...new Set(entries.flatMap((e) => (e.runningApp ? [e.runningApp] : [])))].join(", ")} first, so they aren't using the files.
          </p>
        )}
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
            {mode === "delete" ? `Delete ${formatBytes(sum)}` : "Move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
}
