import { useEffect, useState } from "react";
import { getHistory, restoreCleanup, type Cleanup, type HistoryData } from "../lib/api";
import { formatBytes } from "../lib/format";
import { GB } from "../lib/tray";

const DAY = 86_400;
/** Days with less free space than this show in red, as in the design. */
const LOW = 15 * GB;

interface Props {
  /** Called after a restore, so the rest of the app can refresh. */
  onChanged: () => void;
  onError: (message: string) => void;
}

const dayOf = (unix: number) => Math.floor(unix / DAY);
const dateLabel = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Bytes of an item that a cleanup actually took away (restored paths don't count). */
function keptOff(item: Cleanup["items"][number]) {
  const paths = item.paths.length || 1;
  return (item.size * item.paths.filter((p) => !p.restored).length) / paths;
}

function status(c: Cleanup): { label: string; tone: "trash" | "plain" } {
  const paths = c.items.flatMap((i) => i.paths);
  if (paths.every((p) => p.restored)) return { label: "Restored", tone: "plain" };
  if (paths.some((p) => p.inTrash)) return { label: "In Trash", tone: "trash" };
  return { label: c.mode === "delete" ? "Deleted" : "Emptied", tone: "plain" };
}

export function HistoryView({ onChanged, onError }: Props) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [range, setRange] = useState<30 | 90>(90);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => getHistory().then(setData, (e) => onError(String(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;

  const now = Date.now() / 1000;
  const since = now - range * DAY;
  const cleanups = data.cleanups.filter((c) => c.at >= since).sort((a, b) => b.at - a.at);
  const reclaimed = cleanups.reduce((sum, c) => sum + c.items.reduce((s, i) => s + keptOff(i), 0), 0);
  const inTrash = data.cleanups.reduce(
    (sum, c) => sum + c.items.reduce((s, i) => s + (i.size * i.paths.filter((p) => p.inTrash).length) / (i.paths.length || 1), 0),
    0,
  );
  const trashedOn = data.cleanups.filter((c) => c.items.some((i) => i.paths.some((p) => p.inTrash))).map((c) => c.at);

  // How fast the disk fills: free space lost between samples, ignoring cleanups (gains).
  const samples = data.samples.filter((s) => s.at >= since);
  let lost = 0;
  for (let i = 1; i < samples.length; i++) lost += Math.max(0, samples[i - 1].free - samples[i].free);
  const spanDays = samples.length > 1 ? (samples[samples.length - 1].at - samples[0].at) / DAY : 0;
  const perDay = spanDays >= 1 ? lost / spanDays : null;

  const every = cleanups.length > 1 ? Math.round((cleanups[0].at - cleanups[cleanups.length - 1].at) / DAY / (cleanups.length - 1)) : null;

  return (
    <div className="history">
      <section className="card stats-row">
        <div>
          <span className="muted small">Reclaimed in {range} days</span>
          <strong className="mono good">{formatBytes(reclaimed)}</strong>
        </div>
        <div>
          <span className="muted small">Cleanups</span>
          <span className="stat-line">
            <strong className="mono">{cleanups.length}</strong>
            {every !== null && <span className="muted small">about every {Math.max(1, every)} days</span>}
          </span>
        </div>
        <div>
          <span className="muted small">Disk fills by</span>
          <span className="stat-line">
            <strong className="mono">{perDay === null ? "—" : formatBytes(perDay)}</strong>
            <span className="muted small">{perDay === null ? "needs a day of data" : "a day on average"}</span>
          </span>
        </div>
        <div>
          <span className="muted small">In Trash, restorable</span>
          <span className="stat-line">
            <strong className="mono">{formatBytes(inTrash)}</strong>
            {trashedOn.length > 0 && <span className="muted small">from {dateLabel(Math.min(...trashedOn))}</span>}
          </span>
        </div>
      </section>

      <FreeSpaceChart data={data} range={range} onRange={setRange} />

      <div className="history-grid">
        <section className="card past">
          <header className="card-head">
            <h2>Past cleanups</h2>
          </header>
          {data.cleanups.length === 0 && <p className="muted pad">Nothing cleaned yet. Cleanups show up here, and you can restore from them while they're in the Trash.</p>}
          {[...data.cleanups]
            .sort((a, b) => b.at - a.at)
            .map((c) => {
              const st = status(c);
              const isOpen = open === c.id;
              return (
                <div key={c.id} className="past-item">
                  <button className="past-row" onClick={() => setOpen(isOpen ? null : c.id)}>
                    <span className="past-date">
                      <strong>{dateLabel(c.at)}</strong>
                      <span className="muted">{Math.floor((now - c.at) / DAY) || "0"} days ago</span>
                    </span>
                    <span className="past-summary">
                      {c.items
                        .map((i) => i.label)
                        .slice(0, 3)
                        .join(", ")}
                      {c.items.length > 3 ? ` +${c.items.length - 3}` : ""}
                    </span>
                    <span className={`pill ${st.tone}`}>{st.label}</span>
                    <span className="mono past-size">{formatBytes(c.items.reduce((s, i) => s + i.size, 0))}</span>
                    <span className="muted chev">{isOpen ? "−" : "+"}</span>
                  </button>
                  {isOpen &&
                    c.items.map((i) => {
                      const restorable = i.paths.filter((p) => p.inTrash);
                      return (
                        <div key={i.label + i.paths[0]?.original} className="past-sub">
                          <span>{i.label}</span>
                          <span className="mono">{formatBytes(i.size)}</span>
                          {restorable.length > 0 ? (
                            <button
                              className="small-btn"
                              onClick={async () => {
                                const failed = await restoreCleanup(
                                  c.id,
                                  restorable.map((p) => p.original),
                                ).catch((e) => {
                                  onError(String(e));
                                  return [];
                                });
                                if (failed.length) onError(`Couldn't restore: ${failed.map((f) => `${f.path} (${f.error})`).join(", ")}`);
                                await load();
                                onChanged();
                              }}
                            >
                              Restore
                            </button>
                          ) : (
                            <span className="muted small">{i.paths.every((p) => p.restored) ? "restored" : "gone"}</span>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
        </section>
        <GrowsBack data={data} />
      </div>
    </div>
  );
}

function FreeSpaceChart({ data, range, onRange }: { data: HistoryData; range: 30 | 90; onRange: (r: 30 | 90) => void }) {
  const today = dayOf(Date.now() / 1000);
  const first = today - range + 1;
  // Last sample of each day.
  const free = new Map<number, number>();
  for (const s of data.samples) free.set(dayOf(s.at), s.free);
  const freed = new Map<number, number>();
  for (const c of data.cleanups) freed.set(dayOf(c.at), (freed.get(dayOf(c.at)) ?? 0) + c.items.reduce((s, i) => s + keptOff(i), 0));

  const days = Array.from({ length: range }, (_, i) => first + i);
  const values = days.map((d) => free.get(d));
  const max = Math.max(20 * GB, ...values.filter((v): v is number => v !== undefined)) * 1.15;
  const step = max > 200 * GB ? 100 * GB : max > 80 * GB ? 40 * GB : 20 * GB;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const hasData = values.some((v) => v !== undefined);
  const labelEvery = range === 90 ? 15 : 5;

  return (
    <section className="card chart">
      <header className="card-head">
        <div>
          <h2>Free space</h2>
          <p className="muted small">Green bars mark cleanups. Red means under 15 GB free.</p>
        </div>
        <div className="segmented">
          {([30, 90] as const).map((r) => (
            <button key={r} className={range === r ? "active" : ""} onClick={() => onRange(r)}>
              {r} days
            </button>
          ))}
        </div>
      </header>
      <div className="chart-body">
        <div className="chart-y">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>
              {Math.round(t / GB)} GB
            </span>
          ))}
        </div>
        <div className="chart-plot">
          {ticks.map((t) => (
            <i key={t} className="gridline" style={{ bottom: `${(t / max) * 100}%` }} />
          ))}
          {days.map((d, i) => {
            const v = values[i];
            const gain = freed.get(d);
            const tone = gain ? "gain" : v !== undefined && v < LOW ? "low" : "";
            return (
              <div key={d} className="bar-slot" title={v === undefined ? `${dateLabel(d * DAY)} · no data` : `${dateLabel(d * DAY)} · ${formatBytes(v)} free`}>
                {v !== undefined && (
                  <div className={`bar ${tone}`} style={{ height: `${(v / max) * 100}%` }}>
                    {gain && <span className="bar-label mono">+{formatBytes(gain)}</span>}
                  </div>
                )}
                {(today - d) % labelEvery === 0 && <span className="bar-x">{d === today ? "today" : dateLabel(d * DAY)}</span>}
              </div>
            );
          })}
          {!hasData && <p className="chart-empty muted">Kurz records free space while it runs. The chart fills in over the coming days.</p>}
        </div>
      </div>
    </section>
  );
}

/** Size gained since the item last shrank (a cleanup), and how fast, from per-scan sizes. */
function growthOf(sizes: [number, number][]) {
  if (sizes.length < 2) return null;
  let start = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i][1] < sizes[i - 1][1]) start = i;
  const [t0, s0] = sizes[start];
  const [t1, s1] = sizes[sizes.length - 1];
  const days = (t1 - t0) / DAY;
  if (days < 1 || s1 <= s0) return null;
  return { perWeek: ((s1 - s0) / days) * 7, now: s1, spark: sizes.slice(-8).map(([, s]) => s) };
}

function GrowsBack({ data }: { data: HistoryData }) {
  const rows = Object.entries(data.growth)
    .map(([id, g]) => ({ id, ...g, growth: growthOf(g.sizes) }))
    .filter((r) => r.growth && r.growth.perWeek > 50e6)
    .sort((a, b) => b.growth!.perWeek - a.growth!.perWeek)
    .slice(0, 6);

  return (
    <section className="card grows">
      <header className="card-head">
        <div>
          <h2>What grows back</h2>
          <p className="muted small">Growth since the last cleanup, from your scans</p>
        </div>
      </header>
      {rows.length === 0 && (
        <p className="muted pad">Kurz compares sizes between scans. Scan again in a few days to see which folders keep growing back.</p>
      )}
      {rows.map((r) => {
        const g = r.growth!;
        const top = Math.max(...g.spark);
        return (
          <div key={r.id} className="grow-row">
            <div className="grow-name">
              <span>{r.label}</span>
              <span className="mono muted">{r.location}</span>
            </div>
            <div className="spark">
              {g.spark.map((v, i) => (
                <i key={i} style={{ height: `${Math.max(2, (v / top) * 30)}px` }} />
              ))}
            </div>
            <div className="grow-rate">
              <strong className="mono short">+{formatBytes(g.perWeek)} / week</strong>
              <span className="muted small">{formatBytes(g.now)} now</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
