import { useEffect, useState } from "react";
import { howItWorks, type HowItWorksInfo, type RuleInfo } from "../lib/api";
import { CATEGORIES } from "../lib/categories";
import { RISKS } from "../lib/tray";

/** Explains, from the app's own rules, how scanning, recommendations and removal work. */
export function HowItWorks() {
  const [info, setInfo] = useState<HowItWorksInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    howItWorks().then(setInfo, (e) => setError(String(e)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!info) return null;


  return (
    <section className="panel docs">
      <nav className="docs-toc">
        <a href="#scan">Scanning</a>
        <a href="#categories">Categories</a>
        <a href="#recommendations">Recommendations</a>
        <a href="#never">Never touched</a>
        <a href="#removal">Removal</a>
      </nav>

      <article className="docs-body">
        <section id="scan">
          <h2>Scanning</h2>
          <p>Kurz reads your home folder once and keeps a map of sizes in memory. It never writes anything while scanning.</p>
          <ul>
            <li>
              <strong>Real disk usage.</strong> Sizes are the space files actually take on disk, the same number <code>du</code>{" "}
              reports, so sparse and compressed files aren't overcounted.
            </li>
            <li>
              <strong>Parallel.</strong> Folders are read on all CPU cores at once.
            </li>
            <li>
              <strong>No double counting.</strong> Symlinks are not followed, other disks mounted inside your home are skipped, and a file
              with several hard links counts once.
            </li>
            <li>
              <strong>Unreadable folders</strong> (usually protected by macOS) are counted and skipped; give Kurz Full Disk Access to read
              them.
            </li>
            <li>
              <strong>Small items are grouped.</strong> The map shows up to {info.maxChildren} items per folder; anything under{" "}
              {(info.minShare * 100).toFixed(2)}% of the folder you're viewing joins a striped "more items" tile.
            </li>
          </ul>
        </section>

        <section id="categories">
          <h2>Categories</h2>
          <p>
            Map colors come from the folder's name and place. A folder inherits its parent's category, except that caches inside a project
            are still caches.
          </p>
          <table>
            <tbody>
              {info.categories.map((c) => (
                <tr key={c.category}>
                  <th>
                    <i className={`swatch cat-${c.category}`} /> {CATEGORIES.find((x) => x.id === c.category)?.label}
                  </th>
                  <td>
                    {c.examples.map((e) => (
                      <code key={e}>{e}</code>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="recommendations">
          <h2>Recommendations</h2>
          <p>
            After a scan, Kurz checks these rules against the map. When a folder matches, nothing inside it is matched again, so no byte
            is counted twice, and anything under 50 MB is left out. A project is <em>idle</em> when nothing in it changed for{" "}
            {info.idleDays} days. Each item shows when anything in it last changed.
          </p>
          {RISKS.map((risk) => (
            <RuleTable key={risk.id} title={risk.title} note={risk.desc} rules={info.rules.filter((r) => r.risk === risk.id)} risk={risk.id} />
          ))}
        </section>

        <section id="never">
          <h2>Never touched</h2>
          <p>Kurz refuses to recommend or remove anything in these places, even if a rule were to match inside them.</p>
          <ul className="never">
            {info.never.map(([path, what]) => (
              <li key={path}>
                <code>{path}</code> <span className="muted">{what}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="removal">
          <h2>Removal</h2>
          <ol>
            <li>
              <strong>You fill the tray.</strong> Set how much space you need and Kurz fills the tray with the safest, largest items first.
              Add or remove anything by hand.
            </li>
            <li>
              <strong>You confirm, and pick how.</strong> The confirmation sums the tray up by risk and asks every time:{" "}
              <em>Move to Trash</em> (the default) or <em>Delete permanently</em> (frees space right away, cannot be undone).
            </li>
            <li>
              <strong>Kurz checks again.</strong> Right before removing, each path is re-checked: it still exists, it's inside your home
              folder even after resolving symlinks, and it isn't in a protected place. Anything that fails is skipped and reported.
            </li>
            <li>
              <strong>One path at a time.</strong> Progress is shown live; if one path fails (permissions, in use), the rest continue.
            </li>
            <li>
              <strong>Undo, or free it for good.</strong> Kurz remembers where each item went in the Trash, so <em>Undo</em> puts it back.
              Items in the Trash still use space: <em>Empty from Trash</em> deletes just that cleanup's items and leaves the rest of your
              Trash alone.
            </li>
          </ol>
        </section>
      </article>
    </section>
  );
}

/** Renders `backticked` parts of rule texts as code. */
function Text({ children }: { children: string }) {
  return <>{children.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

function RuleTable({ title, note, rules, risk }: { title: string; note: string; rules: RuleInfo[]; risk: string }) {
  return (
    <>
      <h3>
        <span className={`badge ${risk}`}>{title}</span>
      </h3>
      <p className="muted">{note}</p>
      <table className="rules">
        <thead>
          <tr>
            <th>What</th>
            <th>Where</th>
            <th>After removal</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.label}</strong>
                <div className="muted">
                  <Text>{r.reason}</Text>
                </div>
              </td>
              <td>
                <code>{r.matches}</code>
                {r.needsIdleProject && <div className="muted">only in idle projects</div>}
              </td>
              <td>
                <Text>{r.restore}</Text>
                {r.command && (
                  <div className="muted">
                    Script uses <code>{r.command}</code>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
