import type { TreeNode } from "../lib/api";
import { formatBytes } from "../lib/format";
import { CATEGORIES, sizeByCategory } from "../lib/categories";
import { Treemap } from "./Treemap";

export type ExplorerView = "map" | "list";

interface Props {
  node: TreeNode;
  root: string;
  view: ExplorerView;
  onViewChange: (view: ExplorerView) => void;
  onOpen: (path: string | null) => void;
}

export function Explorer({ node, root, view, onViewChange, onOpen }: Props) {
  const relative = node.path.slice(root.length).split("/").filter(Boolean);

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Explorer</h2>
          <p className="muted">Your home folder, sized by space used. Click a tile to open it.</p>
        </div>
        <div className="segmented">
          <button className={view === "map" ? "active" : ""} onClick={() => onViewChange("map")}>
            Map
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => onViewChange("list")}>
            List
          </button>
        </div>
      </header>
      <nav className="crumbs">
        <button className="link" onClick={() => onOpen(null)}>
          ~ Home
        </button>
        {relative.map((part, i) => (
          <span key={i}>
            <span className="muted sep">/</span>
            <button className="link" onClick={() => onOpen(root + "/" + relative.slice(0, i + 1).join("/"))}>
              {part}
            </button>
          </span>
        ))}
        <span className="size">{formatBytes(node.size)}</span>
      </nav>
      {view === "map" ? <Treemap node={node} onOpen={onOpen} /> : <Listing node={node} onOpen={onOpen} />}
      <Legend node={node} />
    </section>
  );
}

function Legend({ node }: { node: TreeNode }) {
  const sizes = sizeByCategory(node);
  const shown = CATEGORIES.filter((c) => (sizes.get(c.id) ?? 0) > 0);
  return (
    <footer className="legend">
      {shown.map((c) => (
        <span key={c.id} className="legend-item">
          <i className={`swatch cat-${c.id}`} />
          {c.label}
          <span className="size">{formatBytes(sizes.get(c.id) ?? 0)}</span>
        </span>
      ))}
      <span className="legend-item">
        <i className="swatch rest" />
        Smaller items, grouped
      </span>
    </footer>
  );
}

function Listing({ node, onOpen }: { node: TreeNode; onOpen: (path: string) => void }) {
  const largest = node.children?.[0]?.size || 1;
  return (
    <ul className="rows">
      {(node.children ?? []).map((child) => {
        const canOpen = child.kind === "dir" && child.files > 0;
        return (
          <li key={child.path + child.name}>
            <button className="row" disabled={!canOpen} onClick={() => onOpen(child.path)}>
              <span className="name">
                <i className={`swatch cat-${child.category}`} /> {child.name}
              </span>
              <span className="bar">
                <span style={{ width: `${(child.size / largest) * 100}%` }} />
              </span>
              <span className="size">{formatBytes(child.size)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
