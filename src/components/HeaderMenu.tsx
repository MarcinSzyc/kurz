import { useEffect, useRef, useState } from "react";

export type Theme = "auto" | "light" | "dark";

/** The light/dark toggle next to the ••• menu; Auto lives in the menu. */
export function ThemeToggle({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const systemDark = useSystemDark();
  const effective = theme === "auto" ? (systemDark ? "dark" : "light") : theme;
  return (
    <div className="segmented theme-toggle" role="group" aria-label="Light or dark">
      <button className={effective === "light" ? "active" : ""} onClick={() => onTheme("light")} title="Light" aria-label="Light">
        <span className="sun" />
      </button>
      <button className={effective === "dark" ? "active" : ""} onClick={() => onTheme("dark")} title="Dark" aria-label="Dark">
        <span className="moon" />
      </button>
    </div>
  );
}

function useSystemDark() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

interface MenuProps {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onHowItWorks: () => void;
  onMenuBar: () => void;
}

/** The ••• menu: How it works, Menu bar, Appearance, and what's coming. */
export function MoreMenu({ theme, onTheme, onHowItWorks, onMenuBar }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="more" ref={ref}>
      <button className={`more-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="More">
        •••
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={pick(onHowItWorks)}>
            How it works…
          </button>
          <button role="menuitem" onClick={pick(onMenuBar)}>
            Menu bar…
          </button>
          <hr />
          <div className="menu-row">
            <span>Appearance</span>
            <div className="mini-seg">
              {(["light", "dark", "auto"] as const).map((t) => (
                <button key={t} className={theme === t ? "active" : ""} onClick={() => onTheme(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <hr />
          <button role="menuitem" disabled>
            Preferences… <span className="soon">soon</span>
          </button>
          <button role="menuitem" disabled>
            Check for updates <span className="soon">soon</span>
          </button>
        </div>
      )}
    </div>
  );
}
