import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import type { TreeNode } from "../lib/api";
import { formatBytes } from "../lib/format";

/** Hues for the top-level tiles, picked to stay distinct as pastels. */
const HUES = [250, 340, 150, 30, 200, 280, 90, 10, 180, 55];
/** Space reserved for a folder's name above its children. */
const HEADER = { 1: 24, 2: 18 } as Record<number, number>;
const MAX_DEPTH = 3;

type Rect = HierarchyRectangularNode<TreeNode>;

interface Props {
  node: TreeNode;
  onOpen: (path: string) => void;
}

/** Bytes a folder holds itself, outside the children we were sent. */
function ownSize(n: TreeNode): number {
  if (!n.children) return n.size;
  return Math.max(0, n.size - n.children.reduce((sum, c) => sum + c.size, 0));
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

export function Treemap({ node, onOpen }: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();

  const tiles = useMemo(() => {
    if (!width || !height) return [];
    const root = hierarchy(node, (n) => n.children ?? undefined)
      .sum(ownSize)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = treemap<TreeNode>()
      .tile(treemapSquarify)
      .size([width, height])
      .paddingInner(3)
      .paddingOuter((d) => (d.depth === 0 ? 0 : 3))
      .paddingTop((d) => HEADER[d.depth] ?? 3)
      .round(true);
    return layout(root)
      .descendants()
      .filter((d) => d.depth > 0 && d.depth <= MAX_DEPTH && d.x1 - d.x0 >= 2 && d.y1 - d.y0 >= 2);
  }, [node, width, height]);

  return (
    <div className="treemap" ref={ref}>
      {tiles.map((d) => (
        <Tile key={`${d.depth}:${d.data.path}:${d.data.name}`} d={d} onOpen={onOpen} />
      ))}
    </div>
  );
}

function topAncestorIndex(d: Rect): number {
  let top = d;
  while (top.depth > 1 && top.parent) top = top.parent;
  return top.parent?.children?.indexOf(top) ?? 0;
}

function Tile({ d, onOpen }: { d: Rect; onOpen: (path: string) => void }) {
  const w = d.x1 - d.x0;
  const h = d.y1 - d.y0;
  const { data } = d;
  const openable = data.kind === "dir" && data.files > 0;
  const isGroup = !!d.children && d.depth < MAX_DEPTH;
  const showName = w > 44 && h > 16;
  const showBigSize = !isGroup && w > 70 && h > 46;

  return (
    <div
      className={`tile depth-${d.depth} ${data.kind} ${openable ? "openable" : ""}`}
      style={{
        left: d.x0,
        top: d.y0,
        width: w,
        height: h,
        ["--h" as string]: HUES[topAncestorIndex(d) % HUES.length],
      }}
      title={`${data.kind === "rest" ? data.name + " in " : ""}${data.path}\n${formatBytes(data.size)}`}
      onClick={(e) => {
        e.stopPropagation();
        if (openable) onOpen(data.path);
      }}
    >
      {showName && (
        <div className="tile-head">
          <span className="tile-name">{data.name}</span>
          {isGroup && w > 120 && <span className="tile-size">{formatBytes(data.size)}</span>}
        </div>
      )}
      {showBigSize && <span className="tile-big">{formatBytes(data.size)}</span>}
    </div>
  );
}
