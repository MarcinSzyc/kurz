import { useState } from "react";
import type { DockerItem, DockerReport } from "../lib/api";
import { formatBytes } from "../lib/format";
import { ago, fromDocker, type TrayEntry } from "../lib/tray";

/** Rows shown per group before "Show all". */
const PREVIEW = 6;

interface Props {
  report: DockerReport | null;
  error: string | null;
  tray: TrayEntry[];
  onToggle: (entry: TrayEntry) => void;
  onAddMany: (entries: TrayEntry[]) => void;
}

const sum = (items: DockerItem[]) => items.reduce((s, i) => s + i.size, 0);

/** What's inside Docker's disk image, each piece removable on its own. */
export function DockerPanel({ report, error, tray, onToggle, onAddMany }: Props) {
  const inTray = (item: DockerItem) => tray.some((e) => e.key === fromDocker(item).key);

  if (error) return <div className="docker-panel"><p className="muted small">{error}</p></div>;
  if (!report) {
    return (
      <div className="docker-panel">
        <p className="muted small">Asking Docker what's inside… this takes a few seconds.</p>
      </div>
    );
  }

  const groups: { title: string; desc: string; items: DockerItem[]; locked: string }[] = [
    {
      title: "Images",
      desc: "Pulled or built images. Pull or build them again when needed.",
      items: report.images,
      locked: "used by containers",
    },
    {
      title: "Stopped containers",
      desc: "Their own changes on top of the image. Running ones can't be removed.",
      items: report.containers,
      locked: "running",
    },
    {
      title: "Volumes",
      desc: "Data containers keep, like databases. Look before removing: this is often your data.",
      items: report.volumes,
      locked: "attached to containers",
    },
  ];

  return (
    <div className="docker-panel">
      <p className="docker-note muted small">
        Docker removes these itself, for good: no Trash, no Undo. Docker Desktop gives the space back to macOS over a few minutes.
      </p>
      {report.buildCache && (
        <div className="docker-group">
          <div className="docker-row">
            <div className="rec-name">
              <span className="rec-title">
                <span>Build cache</span>
                <span className="badge risk-safe">Safe</span>
              </span>
              <span className="rec-about">{report.buildCache.detail}. Rebuilt by the next docker build.</span>
            </div>
            <span className="muted small">used {ago(report.buildCache.created)}</span>
            <span className="mono rec-size">{formatBytes(report.buildCache.size)}</span>
            <button className={`tray-btn ${inTray(report.buildCache) ? "on" : ""}`} onClick={() => onToggle(fromDocker(report.buildCache!))}>
              {inTray(report.buildCache) ? "✓ In tray" : "+ Add"}
            </button>
          </div>
        </div>
      )}
      {groups.map((g) => (
        <DockerGroup key={g.title} {...g} inTray={inTray} onToggle={onToggle} onAddMany={onAddMany} />
      ))}
    </div>
  );
}

function DockerGroup(props: {
  title: string;
  desc: string;
  items: DockerItem[];
  locked: string;
  inTray: (i: DockerItem) => boolean;
  onToggle: (e: TrayEntry) => void;
  onAddMany: (e: TrayEntry[]) => void;
}) {
  const [all, setAll] = useState(false);
  const free = props.items.filter((i) => !i.inUse);
  const used = props.items.filter((i) => i.inUse);
  if (props.items.length === 0) return null;
  const shown = all ? free : free.slice(0, PREVIEW);
  const missing = free.filter((i) => !props.inTray(i));

  return (
    <div className="docker-group">
      <div className="docker-group-head">
        <div>
          <strong>{props.title}</strong>
          <span className="mono muted small">
            {" "}
            {formatBytes(sum(free))} unused · {free.length} of {props.items.length}
          </span>
          <div className="muted small">{props.desc}</div>
        </div>
        {free.length > 0 && (
          <button className="small-btn" onClick={() => props.onAddMany(missing.map(fromDocker))} disabled={missing.length === 0}>
            {missing.length === 0 ? "All in tray" : "Add all unused"}
          </button>
        )}
      </div>
      {shown.map((i) => {
        const on = props.inTray(i);
        return (
          <div key={i.id} className={`docker-row ${on ? "on" : ""}`}>
            <div className="rec-name">
              <span className="mono" title={i.name}>
                {i.name}
              </span>
              <span className="rec-about">
                {i.detail}
                {i.project ? ` · ${i.project}` : ""}
              </span>
            </div>
            <span className="muted small">{i.created ? `created ${ago(i.created)}` : ""}</span>
            <span className="mono rec-size">{formatBytes(i.size)}</span>
            <button className={`tray-btn ${on ? "on" : ""}`} onClick={() => props.onToggle(fromDocker(i))}>
              {on ? "✓ In tray" : "+ Add"}
            </button>
          </div>
        );
      })}
      {free.length > PREVIEW && (
        <button className="link muted small show-all" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${free.length}`}
        </button>
      )}
      {used.length > 0 && (
        <p className="muted small docker-locked">
          + {used.length} {props.locked} ({formatBytes(sum(used))}), kept.
        </p>
      )}
    </div>
  );
}
