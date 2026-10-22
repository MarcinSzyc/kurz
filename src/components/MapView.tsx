import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { Category, Recommendation, TreeNode } from "../lib/api";
import { CATEGORIES } from "../lib/categories";
import { formatBytes } from "../lib/format";
import { covers, riskOfFolder, type TrayEntry } from "../lib/tray";

/** Tiles at the current level, and inside a folder shown as a group. */
const MAX_TILES = 9;
const MAX_KIDS = 6;
/** Stop adding tiles once they cover this share; the rest becomes one "+N more" tile. */
const COVER = 0.93;
const GAP = 4;
const GROUP_HEADER = 30;

interface Props {
  node: TreeNode;
  root: string;
  items: Recommendation[];
  tray: TrayEntry[];
  onOpen: (path: string | null) => void;
  onToggleFolder: (node: TreeNode) => void;
  trayPanel: ReactNode;
}

type Shown = { node: TreeNode; more?: undefined } | { more: { name: string; size: number }; node?: undefined };

/** The biggest entries, then everything else merged into one, as in the design. */
function trim(list: TreeNode[], max: number): Shown[] {
  const total = list.reduce((sum, n) => sum + n.size, 0);
  const real = list.filter((n) => n.kind !== "rest").sort((a, b) => b.size - a.size);
  const folded = list.filter((n) => n.kind === "rest").reduce((sum, n) => sum + (parseInt(n.name, 10) || 0), 0);
  const keep: Shown[] = [];
  let covered = 0;
  for (const n of real) {
    if (keep.length >= max || (covered >= total * COVER && keep.length >= 2)) break;
    keep.push({ node: n });
    covered += n.size;
  }
  const rest = total - covered;
  const count = real.length - keep.length + folded;
  if (rest > total * 0.004) keep.push({ more: { name: count ? `+${count} more` : "other", size: rest } });
  return keep;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout(sizes: number[], box: Rect): Rect[] {
  const root = hierarchy({ children: sizes.map((v, i) => ({ v, i })) } as { v?: number; i?: number; children?: { v: number; i: number }[] })
    .sum((d) => d.v ?? 0);
  const out: Rect[] = new Array(sizes.length);
  treemap<typeof root.data>().tile(treemapSquarify).size([Math.max(0, box.w), Math.max(0, box.h)])(root)
    .leaves()
    .forEach((l) => {
      out[l.data.i!] = { x: box.x + l.x0, y: box.y + l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 };
    });
  return out;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface Tile extends Rect {
  key: string;
  node?: TreeNode;
  more?: { name: string; size: number };
}

interface Group extends Rect {
  node: TreeNode;
}

export function MapView({ node, root, items, tray, onOpen, onToggleFolder, trayPanel }: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [onlyRemovable, setOnlyRemovable] = useState(false);
  const inTray = (path: string) => tray.some((e) => covers(e, path));

  const { tiles, groups } = useMemo(() => {
    const tiles: Tile[] = [];
    const groups: Group[] = [];
    if (!width || !height) return { tiles, groups };
    const top = trim(node.children ?? [], MAX_TILES);
    const rects = layout(
      top.map((s) => (s.node ?? s.more).size),
      { x: 0, y: 0, w: width, h: height },
    );
    top.forEach((shown, i) => {
      const r = rects[i];
      const box = { x: r.x + GAP, y: r.y + GAP, w: r.w - 2 * GAP, h: r.h - 2 * GAP };
      const n = shown.node;
      if (n && n.children?.length && box.w >= 150 && box.h >= 120 && !inTray(n.path)) {
        groups.push({ ...box, node: n });
        const kids = trim(n.children, MAX_KIDS);
        const kr = layout(
          kids.map((k) => (k.node ?? k.more).size),
          { x: box.x + 5, y: box.y + GROUP_HEADER, w: box.w - 10, h: box.h - GROUP_HEADER - 5 },
        );
        kids.forEach((k, j) => {
          const b = kr[j];
          tiles.push({ key: k.node?.path ?? `${n.path}/+more`, x: b.x + 2.5, y: b.y + 2.5, w: b.w - 5, h: b.h - 5, node: k.node, more: k.more });
        });
      } else {
        tiles.push({ key: n?.path ?? `${node.path}/+more`, ...box, node: n, more: shown.more });
      }
    });
    return { tiles: tiles.filter((t) => t.w >= 3 && t.h >= 3), groups };
    // inTray is derived from tray, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, width, height, tray]);

  const relative = node.path.slice(root.length).split("/").filter(Boolean);
  const shownCategories = new Set<Category>(tiles.flatMap((t) => (t.node ? [t.node.category] : [])));

  return (
    <div className="mapview">
      <section className="card map-card">
        <div className="map-head">
          <nav className="crumbs plain">
            <button className={`link ${relative.length ? "muted" : ""}`} onClick={() => onOpen(null)}>
              ~ Home
            </button>
            {relative.map((part, i) => (
              <span key={i}>
                <span className="sep">/</span>
                <button
                  className={`link ${i < relative.length - 1 ? "muted" : ""}`}
                  onClick={() => onOpen(root + "/" + relative.slice(0, i + 1).join("/"))}
                >
                  {part}
                </button>
              </span>
            ))}
            <span className="mono muted level-size">{formatBytes(node.size)}</span>
          </nav>
          <label className="switch">
            <span>Only removable</span>
            <input type="checkbox" checked={onlyRemovable} onChange={(e) => setOnlyRemovable(e.target.checked)} />
            <i />
          </label>
        </div>

        <div className="calm-map" ref={ref}>
          {groups.map((g) => (
            <div key={"g:" + g.node.path} className={`calm-group cat-${g.node.category}`} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
              <button className="calm-group-head" onClick={() => onOpen(g.node.path)} title={`Open ${g.node.name}`}>
                <span>{g.node.name} ›</span>
                <span className="mono">{formatBytes(g.node.size)}</span>
              </button>
            </div>
          ))}
          {tiles.map((t) => {
            const style = { left: t.x, top: t.y, width: t.w, height: t.h };
            if (!t.node) {
              return (
                <div key={t.key} className="calm-tile more" style={style} title={t.more!.name}>
                  {t.w > 70 && t.h > 34 && <span className="calm-name">{t.more!.name}</span>}
                  {t.w > 70 && t.h > 62 && <span className="calm-size mono">{formatBytes(t.more!.size)}</span>}
                </div>
              );
            }
            const n = t.node;
            const picked = inTray(n.path);
            const locked = n.protected;
            const dim = onlyRemovable && !picked && riskOfFolder(n, items) === "takeALook";
            const big = t.w > 200 && t.h > 150;
            return (
              <div
                key={t.key}
                className={`calm-tile cat-${n.category} ${picked ? "picked" : ""} ${dim ? "dim" : ""} ${locked ? "locked" : ""}`}
                style={style}
                title={`${n.path.replace(root, "~")} · ${formatBytes(n.size)}${locked ? "\nKurz never removes this as a whole; open it to pick what's inside" : ""}`}
                onClick={() => !locked && onToggleFolder(n)}
              >
                {t.w > 64 && t.h > 40 && <span className="calm-name">{n.name}</span>}
                {t.w > 64 && t.h > 64 && <span className={`calm-size mono ${big ? "big" : ""}`}>{formatBytes(n.size)}</span>}
                {locked && t.w > 40 && t.h > 30 && <span className="calm-lock" aria-label="Protected">🔒</span>}
                {picked && t.w > 110 && t.h > 56 && <span className="calm-badge">✓ In tray</span>}
                {picked && !(t.w > 110 && t.h > 56) && t.w > 16 && <span className="calm-dot" />}
                {!picked && n.kind === "dir" && n.files > 1 && t.w > 100 && t.h > 80 && (
                  <button
                    className="calm-open"
                    title={`Open ${n.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(n.path);
                    }}
                  >
                    ›
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <footer className="legend plain">
          {CATEGORIES.filter((c) => shownCategories.has(c.id)).map((c) => (
            <span key={c.id} className="legend-item">
              <i className={`swatch cat-${c.id}`} />
              {c.label}
            </span>
          ))}
          <span className="legend-item muted">Click a tile to add it to the tray · › opens a folder</span>
        </footer>
      </section>
      {trayPanel}
    </div>
  );
}
