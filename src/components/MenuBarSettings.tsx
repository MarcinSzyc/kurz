import { useEffect, useRef, useState } from "react";
import { setMenuBarSettings, type DiskInfo, type MenuBarSettings, type MenuBarText } from "../lib/api";

const TEXT_OPTIONS: { id: MenuBarText; label: string }[] = [
  { id: "percentUsed", label: "Percent used" },
  { id: "usedOfTotal", label: "Used of total" },
  { id: "free", label: "Free space" },
  { id: "none", label: "Icon only" },
];
const REFRESH_OPTIONS = [1, 5, 15, 60];
const SAVE_DELAY_MS = 250;

interface Props {
  initial: MenuBarSettings;
  disk: DiskInfo | null;
  onClose: () => void;
  onSaved: (settings: MenuBarSettings) => void;
}

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
      const used = disk.used / (unit === "TB" ? 1e12 : 1e9);
      return `${num(used)}/${num(total)} ${unit}`;
    }
    case "free": {
      const [free, unit] = short(disk.available);
      return `${num(free)} ${unit} free`;
    }
    case "none":
      return "";
  }
}

function level(usedPercent: number, s: MenuBarSettings) {
  return usedPercent >= s.criticalAt ? "critical" : usedPercent >= s.warnAt ? "warning" : "normal";
}

export function Gauge({ fraction, state }: { fraction: number; state: string }) {
  const r = 6.5;
  const f = Math.min(Math.max(fraction, 0), 0.9999);
  const angle = f * 2 * Math.PI;
  const x = 9 + r * Math.sin(angle);
  const y = 9 - r * Math.cos(angle);
  return (
    <svg className={`gauge ${state}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} className="gauge-track" />
      {f > 0 && <path d={`M9 ${9 - r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}`} className="gauge-fill" />}
    </svg>
  );
}

function Preview({ disk, settings, usedPercent, caption }: { disk: DiskInfo; settings: MenuBarSettings; usedPercent: number; caption: string }) {
  // Scale "used" to the sample percentage so the labels stay consistent.
  const sample = { ...disk, used: (disk.total * usedPercent) / 100, available: disk.total * (1 - usedPercent / 100) };
  const text = label(settings.text, sample, usedPercent);
  return (
    <figure className="preview">
      <div className="menubar-strip">
        <span className="menubar-item">
          <Gauge fraction={usedPercent / 100} state={level(usedPercent, settings)} />
          {text && <span>{text}</span>}
        </span>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function MenuBarSettingsPanel({ initial, disk, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update(patch: Partial<MenuBarSettings>) {
    const next = { ...settings, ...patch };
    if (patch.warnAt !== undefined && next.criticalAt <= next.warnAt) next.criticalAt = Math.min(99, next.warnAt + 1);
    if (patch.criticalAt !== undefined && next.warnAt >= next.criticalAt) next.warnAt = Math.max(1, next.criticalAt - 1);
    setSettings(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setMenuBarSettings(next).then(onSaved, (e) => setError(String(e)));
    }, SAVE_DELAY_MS);
  }

  const usedPercent = disk ? (disk.used / disk.total) * 100 : 0;

  return (
    <div className="overlay" onClick={onClose}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Menu bar settings">
        <header className="sheet-head">
          <div>
            <h2>Menu bar</h2>
            <p className="muted">A small disk gauge in the macOS menu bar. Changes apply right away.</p>
          </div>
          <button onClick={onClose}>Done</button>
        </header>

        <label className="field toggle">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span>
            Show Kurz in the menu bar
            <small className="muted">When on, closing the window keeps Kurz running there.</small>
          </span>
        </label>

        <fieldset className="field" disabled={!settings.enabled}>
          <legend>Text next to the gauge</legend>
          <div className="choices">
            {TEXT_OPTIONS.map((o) => (
              <label key={o.id} className={`choice ${settings.text === o.id ? "active" : ""}`}>
                <input type="radio" name="text" checked={settings.text === o.id} onChange={() => update({ text: o.id })} />
                <span>{o.label}</span>
                <small className="muted">{disk ? label(o.id, disk, usedPercent) || "—" : ""}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field" disabled={!settings.enabled}>
          <legend>Colors</legend>
          <Threshold label="Turn orange at" state="warning" value={settings.warnAt} onChange={(warnAt) => update({ warnAt })} />
          <Threshold label="Turn red at" state="critical" value={settings.criticalAt} onChange={(criticalAt) => update({ criticalAt })} />
        </fieldset>

        <fieldset className="field" disabled={!settings.enabled}>
          <legend>Refresh every</legend>
          <div className="segmented inline">
            {REFRESH_OPTIONS.map((m) => (
              <button key={m} className={settings.refreshMinutes === m ? "active" : ""} onClick={() => update({ refreshMinutes: m })}>
                {m < 60 ? `${m} min` : "1 h"}
              </button>
            ))}
          </div>
        </fieldset>

        {disk && settings.enabled && (
          <div className="field">
            <span className="field-label">Preview</span>
            <div className="previews">
              <Preview disk={disk} settings={settings} usedPercent={usedPercent} caption={`Now · ${usedPercent.toFixed(0)}%`} />
              <Preview disk={disk} settings={settings} usedPercent={Math.max(settings.warnAt, 85)} caption="Getting full" />
              <Preview disk={disk} settings={settings} usedPercent={Math.max(settings.criticalAt, 95)} caption="Almost full" />
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}

function Threshold({ label, state, value, onChange }: { label: string; state: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="threshold">
      <Gauge fraction={value / 100} state={state} />
      <span>{label}</span>
      <input type="range" min={50} max={99} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <strong>{value}%</strong>
    </label>
  );
}
