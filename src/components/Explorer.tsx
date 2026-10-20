import type { TreeNode } from "../lib/api";
import { formatBytes } from "../lib/format";
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
    </section>
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
                {child.kind === "dir" ? "📁" : child.kind === "rest" ? "…" : "📄"} {child.name}
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
