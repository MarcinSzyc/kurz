import { useState } from "react";
import type { DockerItem, DockerKind, DockerReport } from "../lib/api";
import { formatBytes } from "../lib/format";
import { ago, dockerStatus, fromDocker, type TrayEntry } from "../lib/tray";

interface Props {
  report: DockerReport | null;
  /** `null` while Docker measures them. */
  volumes: DockerItem[] | null;
  error: string | null;
  /** Size of Docker's disk image, as scanned. */
  diskImage: number;
  tray: TrayEntry[];
  onSet: (entries: TrayEntry[], inTray: boolean) => void;
  onClose: () => void;
}

const sum = (items: DockerItem[]) => items.reduce((s, i) => s + i.size, 0);

interface Tab {
  kind: DockerKind;
  label: string;
  desc: string;
  items: DockerItem[];
  kept: string;
  loading?: boolean;
}

/** What's inside Docker's disk image, each piece removable on its own (design/clean-up-v2.html). */
export function DockerPanel({ report, volumes, error, diskImage, tray, onSet, onClose }: Props) {
  const [tab, setTab] = useState<DockerKind>("image");
  const [showKept, setShowKept] = useState(false);
  const inTray = (item: DockerItem) => tray.some((e) => e.key === fromDocker(item).key);

  if (error || !report) {
    return (
      <div className="dk">
        <p className="dk-wait muted">{error ?? "Asking Docker what's inside…"}</p>
      </div>
    );
  }

  // Named volumes first, then the ones Docker named itself.
  const vols = [...(volumes ?? [])].sort((a, b) => Number(a.anonymous) - Number(b.anonymous) || b.size - a.size);
  const tabs: Tab[] = [
    {
      kind: "image",
      label: "Images",
      desc: "Pulled or built images. Only images no container uses are listed; pull or build them again when needed.",
      items: report.images,
      kept: "used by containers",
    },
    {
      kind: "container",
      label: "Containers",
      desc: "Their own changes on top of the image. Running containers are never removed.",
      items: report.containers,
      kept: "running",
    },
    {
      kind: "volume",
      label: "Volumes",
      desc: "Data containers keep, like databases. Not used by any container now, but often your data: look before removing.",
      items: vols,
      kept: "used by containers",
      loading: volumes === null,
    },
    {
      kind: "buildCache",
      label: "Build cache",
      desc: "Layers kept from docker build to speed up the next build. Safe: the next build just takes longer.",
      items: report.buildCache ? [report.buildCache] : [],
      kept: "",
    },
  ];

  const unused = (t: Tab) => t.items.filter((i) => !i.inUse).sort((a, b) => b.size - a.size);
  const all = tabs.flatMap((t) => t.items);
  const free = all.filter((i) => !i.inUse);
  const picked = free.filter(inTray);
  const scale = Math.max(diskImage, sum(all), 1);
  const running = report.containers.filter((c) => c.inUse).length;

  const bar = tabs.flatMap((t) => {
    const on = sum(unused(t).filter(inTray));
    const off = sum(unused(t)) - on;
    const used = sum(t.items.filter((i) => i.inUse));
    return [
      { cls: "used", size: used, title: `${t.label} in use · ${formatBytes(used)}` },
      { cls: "picked", size: on, title: `${t.label} selected · ${formatBytes(on)}` },
      { cls: "free", size: off, title: `${t.label} unused · ${formatBytes(off)}` },
    ].filter((s) => s.size / scale > 0.002);
  });

  const current = tabs.find((t) => t.kind === tab)!;
  const rows = unused(current);
  const kept = current.items.filter((i) => i.inUse);
  const allOn = rows.length > 0 && rows.every(inTray);

  return (
    <div className="dk">
      <div className="dk-top">
        <div className="dk-line">
          <span>
            Disk image <b className="mono">{formatBytes(diskImage)}</b> · <span className="good">{formatBytes(sum(free))} unused</span>
          </span>
          <span className="muted">
            Docker is running · {running} {running === 1 ? "container" : "containers"} up
          </span>
        </div>
        <div className="dk-bar">
          {bar.map((s, i) => (
            <div key={i} className={s.cls} title={s.title} style={{ width: `${(s.size / scale) * 100}%` }} />
          ))}
        </div>
        <div className="dk-legend">
          <span>
            <i className="used" />
            In use, kept
          </span>
          <span>
            <i className="free" />
            Unused, can go
          </span>
          <span>
            <i className="picked" />
            Selected
          </span>
        </div>
      </div>

      <div className="dk-tabs">
        {tabs.map((t) => {
          const n = unused(t).filter(inTray).length;
          return (
            <button
              key={t.kind}
              className={`dk-tab ${tab === t.kind ? "on" : ""}`}
              onClick={() => {
                setTab(t.kind);
                setShowKept(false);
              }}
            >
              <span className="dk-tab-head">
                <strong>{t.label}</strong>
                <span className={`dk-count ${n ? (t.kind === "volume" ? "data" : "some") : ""}`}>{n ? `${n} selected` : "none"}</span>
              </span>
              <span className="dk-tab-size">
                <span className="mono">{t.loading ? "…" : formatBytes(sum(unused(t)))}</span>
                <span className="muted">{t.loading ? "measuring" : t.kind === "buildCache" ? "all unused" : `${unused(t).length} unused`}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="dk-desc">
        <span>{current.desc}</span>
        {rows.length > 0 && (
          <button className="small-btn" onClick={() => onSet(rows.map(fromDocker), !allOn)}>
            {allOn ? "Deselect all" : `Select all ${rows.length}`}
          </button>
        )}
      </div>

      {current.loading && <p className="dk-wait muted">Measuring volume sizes… Docker checks each of them, which takes a few seconds.</p>}
      {!current.loading && rows.length === 0 && <p className="dk-wait muted">Nothing unused here.</p>}

      {rows.map((i) => {
        const on = inTray(i);
        const status = dockerStatus(i);
        return (
          <label key={i.id} className={`dk-row ${on ? "on" : ""}`}>
            <input type="checkbox" checked={on} onChange={() => onSet([fromDocker(i)], !on)} />
            <i className="dk-box">{on ? "✓" : ""}</i>
            <span className="dk-name">
              <span className="mono" title={i.name}>
                {i.name}
              </span>
              <span className="muted">
                {i.project ? `${i.project} · ` : ""}
                {i.detail}
              </span>
            </span>
            <span className="dk-pills">
              {/* Images and volumes listed here are unused; say so, then what kind of unused. */}
              {(i.kind === "image" || i.kind === "volume") && status !== "Unused" && <span className="dk-status fine">Unused</span>}
              <span className={`dk-status ${/data/.test(status) ? "data" : /Unused|Dangling|Anonymous|Cache|Rebuildable/.test(status) ? "fine" : ""}`}>
                {status}
              </span>
            </span>
            <span className="muted small">{i.created ? `${i.kind === "buildCache" || i.kind === "volume" ? "used" : "created"} ${ago(i.created)}` : ""}</span>
            <span className="mono dk-size">{formatBytes(i.size)}</span>
          </label>
        );
      })}

      {showKept &&
        kept.map((i) => (
          <div key={i.id} className="dk-row kept">
            <i className="dk-box" />
            <span className="dk-name">
              <span className="mono">{i.name}</span>
              <span className="muted">{i.detail}</span>
            </span>
            <span className="dk-pills">
              <span className="dk-status">{dockerStatus(i)}</span>
            </span>
            <span />
            <span className="mono dk-size">{formatBytes(i.size)}</span>
          </div>
        ))}

      {kept.length > 0 && (
        <button className="dk-kept" onClick={() => setShowKept(!showKept)}>
          <span>
            + {kept.length} {current.kept} ({formatBytes(sum(kept))}), kept
          </span>
          <span>{showKept ? "Hide" : "Show"}</span>
        </button>
      )}

      <div className="dk-foot">
        <span className="muted">
          Kurz asks Docker to remove these (docker rm, image rm, volume rm, builder prune). It's permanent: no Trash, no Undo.
        </span>
        <div>
          <span>
            In tray <b className="mono">{formatBytes(sum(picked))}</b>
          </span>
          <button className="link muted" onClick={() => onSet(picked.map(fromDocker), false)} disabled={picked.length === 0}>
            Clear
          </button>
          <button className="cta small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
