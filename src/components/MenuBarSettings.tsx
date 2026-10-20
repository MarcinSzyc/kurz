import { useEffect, useRef, useState } from "react";
import { setMenuBarSettings, type DiskInfo, type MenuBarIcon, type MenuBarSettings, type MenuBarText } from "../lib/api";
import icon from "../assets/icon.png";

const ICONS: { id: MenuBarIcon; label: string }[] = [
  { id: "bar", label: "Bar" },
  { id: "tank", label: "Tank" },
  { id: "slabs", label: "Slabs" },
  { id: "sprite", label: "Sprite" },
];
const TEXTS: { id: MenuBarText; label: string }[] = [
  { id: "percentUsed", label: "Percent used" },
  { id: "usedOfTotal", label: "Used of total" },
  { id: "free", label: "Free space" },
  { id: "none", label: "Icon only" },
];
const REFRESH = [1, 5, 15, 60];
const SAVE_DELAY_MS = 250;

type Level = "normal" | "warning" | "critical";

/** Same rules as the Rust side, so the preview matches the real menu bar. */
function short(bytes: number): [number, string] {
  const gb = bytes / 1e9;
  return gb >= 1000 ? [gb / 1000, "TB"] : [gb, "GB"];
}
const num = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

function label(text: MenuBarText, disk: DiskInfo, usedPercent: number): string {
  switch (text) {
    case "percentUsed":
      return `${usedPercent.toFixed(0)}%`;
    case "usedOfTotal": {
      const [total, unit] = short(disk.total);
      return `${num(disk.used / (unit === "TB" ? 1e12 : 1e9))}/${num(total)} ${unit}`;
    }
    case "free": {
      const [free, unit] = short(disk.available);
      return `${num(free)} ${unit}`;
    }
    case "none":
      return "";
  }
}

const levelOf = (p: number, s: MenuBarSettings): Level => (p >= s.criticalAt ? "critical" : p >= s.warnAt ? "warning" : "normal");

/** The menu bar icon drawn in CSS, matching what Rust renders. */
export function MenuBarGlyph({ style, percent, level }: { style: MenuBarIcon; percent: number; level: Level }) {
  const fill = Math.max(8, Math.min(100, percent));
  const cls = `glyph ${level}`;
  switch (style) {
    case "bar":
      return (
        <span className={`${cls} g-bar`}>
          <i style={{ width: `${fill}%` }} />
        </span>
      );
    case "tank":
      return (
        <span className={`${cls} g-tank`}>
          <i style={{ height: `${fill}%` }} />
        </span>
      );
    case "slabs": {
      const lit = Math.ceil(percent / 34);
      return (
        <span className={`${cls} g-slabs`}>
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < lit ? "lit" : ""} />
          ))}
        </span>
      );
    }
    case "sprite":
      return (
        <span className={`${cls} g-sprite`}>
          <img src={icon} alt="" />
          {level !== "normal" && <i />}
        </span>
      );
  }
}

interface Props {
  initial: MenuBarSettings;
  disk: DiskInfo | null;
  onClose: () => void;
  onSaved: (settings: MenuBarSettings) => void;
}

export function MenuBarSettingsPanel({ initial, disk, onClose, onSaved }: Props) {
  const [s, setS] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update(patch: Partial<MenuBarSettings>) {
    const next = { ...s, ...patch };
    if (patch.warnAt !== undefined && next.criticalAt <= next.warnAt) next.criticalAt = Math.min(99, next.warnAt + 1);
    if (patch.criticalAt !== undefined && next.warnAt >= next.criticalAt) next.warnAt = Math.max(1, next.criticalAt - 1);
    setS(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setMenuBarSettings(next).then(onSaved, (e) => setError(String(e)));
    }, SAVE_DELAY_MS);
  }

  const now = disk ? (disk.used / disk.total) * 100 : 58;
  const getting = Math.min(s.criticalAt - 1, Math.max(s.warnAt, 85));
  const almost = Math.max(s.criticalAt, 97);
  // A disk at a sample fullness, for the preview labels.
  const at = (p: number): DiskInfo | null => disk && { ...disk, used: (disk.total * p) / 100, available: disk.total * (1 - p / 100) };

  return (
    <div className="overlay center" onClick={onClose}>
      <section className="sheet modal menubar-modal" role="dialog" aria-label="Menu bar" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Menu bar</h2>
            <p className="sub">A small disk gauge in the macOS menu bar. Changes apply right away.</p>
          </div>
          <button className="cta" onClick={onClose}>
            Done
          </button>
        </header>

        <label className="check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <i />
          <span>
            Show Kurz in the menu bar
            <small className="muted">When on, closing the window keeps Kurz running there.</small>
          </span>
        </label>

        <div className={`modal-body ${s.enabled ? "" : "off"}`}>
          <section>
            <h3 className="eyebrow">Icon</h3>
            <div className="cards four">
              {ICONS.map((o) => (
                <button key={o.id} className={`pick icon-pick ${s.icon === o.id ? "on" : ""}`} onClick={() => update({ icon: o.id })}>
                  <span className="glyph-slot">
                    <MenuBarGlyph style={o.id} percent={58} level="normal" />
                  </span>
                  <span className="pick-label">{o.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="eyebrow">Text next to the icon</h3>
            <div className="cards four">
              {TEXTS.map((o) => (
                <button key={o.id} className={`pick ${s.text === o.id ? "on" : ""}`} onClick={() => update({ text: o.id })}>
                  <span>{o.label}</span>
                  <span className="mono muted">
                    {o.id === "none" ? "—" : disk ? label(o.id, disk, now) + (o.id === "free" ? " free" : "") : ""}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="eyebrow">Colors</h3>
            <Threshold style={s.icon} level="warning" label="Turn amber at" value={s.warnAt} min={50} max={98} onChange={(warnAt) => update({ warnAt })} />
            <Threshold style={s.icon} level="critical" label="Turn coral at" value={s.criticalAt} min={60} max={99} onChange={(criticalAt) => update({ criticalAt })} />
            <p className="muted small">Below the amber level the icon stays monochrome, like other menu bar icons.</p>
          </section>

          <section>
            <h3 className="eyebrow">Refresh every</h3>
            <div className="segmented inline">
              {REFRESH.map((m) => (
                <button key={m} className={s.refreshMinutes === m ? "active" : ""} onClick={() => update({ refreshMinutes: m })}>
                  {m < 60 ? `${m} min` : "1 h"}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="eyebrow">Preview</h3>
            <div className="previews">
              {[
                [now, `Now · ${now.toFixed(0)}%`],
                [getting, "Getting full"],
                [almost, "Almost full"],
              ].map(([p, caption]) => {
                const d = at(p as number);
                const text = d ? label(s.text, d, p as number) : "";
                return (
                  <figure key={caption as string} className="preview">
                    <div className="menubar-strip">
                      <span>Wi-Fi</span>
                      <span className="menubar-item">
                        <MenuBarGlyph style={s.icon} percent={p as number} level={levelOf(p as number, s)} />
                        {text && <span className="mono">{text}</span>}
                      </span>
                      <span className="clock">Tue 14:32</span>
                    </div>
                    <figcaption>{caption}</figcaption>
                  </figure>
                );
              })}
            </div>
          </section>
        </div>

        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}

function Threshold(props: { style: MenuBarIcon; level: Level; label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className={`threshold ${props.level}`}>
      <span className="glyph-slot">
        <MenuBarGlyph style={props.style} percent={props.level === "critical" ? 99 : props.value} level={props.level} />
      </span>
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <strong className="mono">{props.value}%</strong>
    </label>
  );
}
