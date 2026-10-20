import { useEffect, useRef, useState } from "react";
import { howItWorks, type HowItWorksInfo, type Risk } from "../lib/api";
import { CATEGORIES } from "../lib/categories";
import { RISKS } from "../lib/tray";
import icon from "../assets/icon.png";

const NAV = ["Scanning", "Categories", "Recommendations", "Never touched", "Removal"];

const STEPS: [string, string][] = [
  ["You fill the tray", "Set how much space you need and Kurz fills the tray with the safest, largest items first. Add or remove anything by hand."],
  [
    "You confirm, and pick how",
    "The confirmation sums the tray up by risk and asks every time: Move to Trash (the default) or Delete permanently, which frees space right away and can’t be undone.",
  ],
  [
    "Kurz checks again",
    "Right before removing, each path is re-checked: it still exists, it’s inside your home folder even after resolving symlinks, and it isn’t in a protected place. Anything that fails is skipped and reported.",
  ],
  ["One path at a time", "Progress is shown live. If one path fails (permissions, in use), the rest continue."],
];

/** Renders `backticked` parts of rule texts as code. */
function Text({ children }: { children: string }) {
  return <>{children.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** Explains, from the app's own rules, how scanning, recommendations and removal work. */
export function HowItWorks({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<HowItWorksInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<Risk>("safe");
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    howItWorks().then(setInfo, (e) => setError(String(e)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections = () => [...(content.current?.querySelectorAll<HTMLElement>("[data-sec]") ?? [])];

  function go(i: number) {
    const el = content.current;
    const sec = sections()[i];
    if (el && sec) el.scrollTo({ top: sec.offsetTop - 8, behavior: "smooth" });
    setActive(i);
  }

  // Highlight the section being read.
  function onScroll() {
    const el = content.current;
    if (!el) return;
    let a = 0;
    sections().forEach((s, i) => {
      if (s.offsetTop - 40 <= el.scrollTop) a = i;
    });
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) a = NAV.length - 1;
    setActive(a);
  }

  const risk = RISKS.find((r) => r.id === tab)!;

  return (
    <div className="overlay center" onClick={onClose}>
      <section className="sheet modal how-modal" role="dialog" aria-label="How Kurz works" onClick={(e) => e.stopPropagation()}>
        <header className="how-head">
          <div className="brand">
            <img src={icon} alt="" className="how-icon" />
            <div>
              <h2>How Kurz works</h2>
              <p className="sub">What it scans, how it decides what’s safe, and what it never touches.</p>
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="how-grid">
          <nav className="how-nav">
            {NAV.map((label, i) => (
              <button key={label} className={active === i ? "on" : ""} onClick={() => go(i)}>
                <span className="mono">0{i + 1}</span>
                {label}
              </button>
            ))}
            <p className="how-note">
              Everything goes to the Trash first, unless you pick <b>Delete permanently</b>.
            </p>
          </nav>

          <div className="how-content" ref={content} onScroll={onScroll}>
            {error && <p className="error">{error}</p>}
            {info && (
              <>
                <section data-sec="0">
                  <div className="sec-head">
                    <h3>Scanning</h3>
                    <p>Kurz reads your home folder once and keeps a map of sizes in memory. It never writes anything while scanning.</p>
                  </div>
                  <div className="facts">
                    {[
                      ["Real disk usage", "Sizes are the space files actually take on disk, the same number du reports, so sparse and compressed files aren’t overcounted."],
                      ["Parallel", "Folders are read on all CPU cores at once."],
                      ["No double counting", "Symlinks aren’t followed, other disks mounted inside your home are skipped, and a file with several hard links counts once."],
                      ["Unreadable folders", "Usually protected by macOS. They’re counted and skipped; give Kurz Full Disk Access to read them."],
                      [
                        "Small items are grouped",
                        `The map shows up to ${info.maxChildren} items per folder. Anything under ${(info.minShare * 100).toFixed(2)}% of the folder you’re viewing joins a striped “more items” tile.`,
                      ],
                    ].map(([title, text]) => (
                      <div key={title} className="fact">
                        <strong>{title}</strong>
                        <span>{text}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section data-sec="1">
                  <div className="sec-head">
                    <h3>Categories</h3>
                    <p>
                      Map colors come from the folder’s name and place. A folder inherits its parent’s category, except that caches inside a project are
                      still caches.
                    </p>
                  </div>
                  <div className="table-card">
                    {info.categories.map((c) => (
                      <div key={c.category} className={`cat-row cat-${c.category}`}>
                        <span className="cat-name">
                          <i className="swatch" />
                          {CATEGORIES.find((x) => x.id === c.category)?.label}
                        </span>
                        <span className="cat-chips">
                          {c.examples.map((e) => (
                            <span key={e} className="chip-code mono">
                              {e}
                            </span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                <section data-sec="2">
                  <div className="sec-head">
                    <h3>Recommendations</h3>
                    <p>
                      After a scan, Kurz checks these rules against the map. Once a folder matches, nothing inside it is matched again, so no byte is counted
                      twice. Anything under 50 MB is left out. A project is <i>idle</i> when nothing in it has changed for {info.idleDays} days.
                    </p>
                  </div>
                  <div className="risk-tabs">
                    {RISKS.map((r) => (
                      <button key={r.id} className={`risk-tab risk-${r.id} ${tab === r.id ? "on" : ""}`} onClick={() => setTab(r.id)}>
                        <i />
                        {r.title}
                        <span className="mono muted">{info.rules.filter((x) => x.risk === r.id).length}</span>
                      </button>
                    ))}
                  </div>
                  <p className="sub">{risk.desc}</p>
                  <div className="table-card">
                    <div className="rule-row head">
                      <span>What</span>
                      <span>Where</span>
                      <span>After removal</span>
                    </div>
                    {info.rules
                      .filter((r) => r.risk === tab)
                      .map((r) => (
                        <div key={r.id} className="rule-row">
                          <div>
                            {/* The app-caches rule labels each item "<app> cache"; as a rule it reads better whole. */}
                            <strong>{r.id === "app-caches" ? "App caches" : r.label}</strong>
                            <span className="sub">
                              <Text>{r.reason}</Text>
                            </span>
                          </div>
                          <div>
                            <span className="chip-code mono">{r.matches}</span>
                            {r.needsIdleProject && <span className="muted small">only in idle projects</span>}
                          </div>
                          <div>
                            <span>
                              <Text>{r.restore}</Text>
                            </span>
                            {r.command && (
                              <span className={`run risk-${tab}`}>
                                Or run it yourself:<span className="mono">{r.command}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </section>

                <section data-sec="3">
                  <div className="sec-head">
                    <h3>Never touched</h3>
                    <p>Kurz won’t recommend or remove anything in these places, even if a rule matches something inside them.</p>
                  </div>
                  <div className="protected">
                    {info.never.map(([path, what]) => (
                      <div key={path}>
                        <span className="lock">Protected</span>
                        <span className="mono">{path}</span>
                        <span className="muted">{what}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section data-sec="4">
                  <div className="sec-head">
                    <h3>Removal</h3>
                    <p>Four steps from the tray to free space.</p>
                  </div>
                  <div className="steps">
                    {STEPS.map(([title, text], i) => (
                      <div key={title} className="step">
                        <div className="step-rail">
                          <span className="mono">{i + 1}</span>
                          {i < STEPS.length - 1 && <i />}
                        </div>
                        <div>
                          <strong>{title}</strong>
                          <span>{text}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
