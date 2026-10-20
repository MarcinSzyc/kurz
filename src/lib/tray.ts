import type { Category, Recommendation, Risk, TreeNode } from "./api";

export const GB = 1e9;

export const RISKS: { id: Risk; title: string; desc: string; badge: string; sheet: string }[] = [
  {
    id: "safe",
    title: "Safe to delete",
    desc: "Caches and leftovers. Apps recreate them when needed.",
    badge: "Safe",
    sheet: "Caches and leftovers. Apps rebuild them on their own.",
  },
  {
    id: "rebuildable",
    title: "Rebuildable",
    desc: "Dependencies, emulators and build output. Reinstalling or rebuilding brings them back.",
    badge: "Rebuildable",
    sheet: "SDKs, emulators and dependencies. Reinstall them when you need them.",
  },
  {
    id: "takeALook",
    title: "Take a look",
    desc: "May hold your own data or projects. Check before removing.",
    badge: "Take a look",
    sheet: "May contain your own files.",
  },
];

/**
 * The goal's picks: safest group first. Within a group, the largest items go in first, but once
 * the rest of the goal is smaller than an item, the smallest item that still covers it is taken
 * instead, so a few hundred MB short never pulls in a huge item.
 */
export function autoPick(items: Recommendation[], goalBytes: number): string[] {
  const picked: string[] = [];
  let sum = 0;
  for (const risk of RISKS) {
    const pool = items.filter((i) => i.risk === risk.id).sort((a, b) => a.size - b.size);
    while (sum < goalBytes && pool.length) {
      const rest = goalBytes - sum;
      const fit = pool.findIndex((i) => i.size >= rest);
      const [pick] = pool.splice(fit >= 0 ? fit : pool.length - 1, 1);
      picked.push(pick.id);
      sum += pick.size;
    }
  }
  return picked;
}

export function sizeOf(items: Recommendation[], risk?: Risk): number {
  return items.filter((i) => !risk || i.risk === risk).reduce((sum, i) => sum + i.size, 0);
}

/** "today", "5 d ago", "3 wk ago", "4 mo ago", "1.2 yr ago". */
export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor((now - unixSeconds) / 86_400));
  if (d === 0) return "today";
  if (d < 7) return `${d} d ago`;
  if (d < 60) return `${Math.round(d / 7)} wk ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${(d / 365).toFixed(1)} yr ago`;
}

/** Anything in the cleanup tray: a recommendation from Clean up, or a folder picked on the Map. */
export interface TrayEntry {
  key: string;
  label: string;
  /** Where it is, for display. */
  location: string;
  paths: string[];
  size: number;
  risk: Risk;
  category: Category;
  /** An app that should be quit before this is removed. */
  runningApp?: string;
}

export const fromRecommendation = (r: Recommendation): TrayEntry => ({
  runningApp: r.owner?.running ? r.owner.name : undefined,
  key: r.id,
  label: r.label,
  location: r.location,
  paths: r.paths,
  size: r.size,
  risk: r.risk,
  category: r.category,
});

const tilde = (path: string, home: string) => (path.startsWith(home) ? "~" + path.slice(home.length) : path);

/**
 * How risky removing a folder picked on the map is. Recommendations know best: a folder inside one
 * takes its risk, and a folder that is mostly recommended items takes the most cautious of theirs.
 */
export function riskOfFolder(node: TreeNode, items: Recommendation[]): Risk {
  const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + "/");
  const holder = items.find((i) => i.paths.some((p) => inside(node.path, p)));
  if (holder) return holder.risk;
  const within = items.filter((i) => i.paths.every((p) => inside(p, node.path)));
  if (within.length && sizeOf(within) >= node.size / 2) {
    return within.reduce<Risk>((worst, i) => (RISKS.findIndex((r) => r.id === i.risk) > RISKS.findIndex((r) => r.id === worst) ? i.risk : worst), "safe");
  }
  if (node.name === "node_modules" || node.name === ".next") return "rebuildable";
  switch (node.category) {
    case "cache":
      return "safe";
    case "sdk":
    case "devTools":
    case "aiModels":
      return "rebuildable";
    default:
      return "takeALook";
  }
}

export const fromFolder = (node: TreeNode, home: string, items: Recommendation[]): TrayEntry => ({
  key: "path:" + node.path,
  label: node.name,
  location: tilde(node.path.slice(0, node.path.length - node.name.length - 1), home) || "~",
  paths: [node.path],
  size: node.size,
  risk: riskOfFolder(node, items),
  category: node.category,
});

/** True when `path` is one of the entry's paths or inside one. */
export const covers = (entry: TrayEntry, path: string) => entry.paths.some((p) => path === p || path.startsWith(p + "/"));
