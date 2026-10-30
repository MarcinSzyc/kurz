import type { Category, DockerItem, InstalledApp, Leftover, Recommendation, Risk, TreeNode } from "./api";

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
  /** For an app being uninstalled: what goes with it, shown under it in the tray. */
  parts?: { kind: string; size: number }[];
  /** A note for the confirm sheet, e.g. that the app has its own uninstaller. */
  note?: string;
  /** Kurz asks this app to quit itself before removing it. */
  quitsApp?: string;
  /** Removed through Docker rather than as files. */
  docker?: { kind: DockerItem["kind"]; id: string };
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

/** An app being uninstalled, with the parts the user kept ticked. */
export function fromApp(app: InstalledApp, keep: string[]): TrayEntry {
  const parts = app.parts.filter((p, i) => i === 0 || !keep.includes(p.path));
  return {
    key: "app:" + app.id,
    label: app.name,
    location: parts.length > 1 ? `App + ${parts.length - 1} leftover folder${parts.length > 2 ? "s" : ""}` : "App",
    paths: parts.map((p) => p.path),
    size: parts.reduce((sum, p) => sum + p.size, 0),
    risk: "takeALook",
    category: "other",
    parts: parts.map((p) => ({ kind: p.kind, size: p.size })),
    quitsApp: app.running ? app.name : undefined,
    note:
      [
        app.ownUninstaller ? `${app.name} has its own uninstaller; Kurz still removes the app and its leftovers.` : "",
        app.needsAdmin ? `${app.name} was installed for all users, so macOS will ask for your password.` : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

/** Data left behind by an app that's gone. */
export const fromLeftover = (l: Leftover): TrayEntry => ({
  key: "left:" + l.id,
  label: `${l.guess} leftovers`,
  location: l.id,
  paths: l.paths,
  size: l.size,
  risk: "safe",
  category: "other",
});

/** "1 item", "3 items" */
export const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/**
 * Adds an entry to the tray, taking out whatever it already contains so nothing counts twice:
 * extra entries (map folders, apps, leftovers) and picked recommendations inside it.
 */
export function addEntry(extras: TrayEntry[], selected: string[], items: Recommendation[], entry: TrayEntry) {
  return {
    // Docker items have no paths, so a folder never contains them.
    extras: [...extras.filter((e) => e.paths.length === 0 || !e.paths.every((p) => covers(entry, p))), entry],
    selected: selected.filter((id) => !items.find((i) => i.id === id)?.paths.every((p) => covers(entry, p))),
  };
}

const DOCKER_RISK: Record<DockerItem["kind"], Risk> = { buildCache: "safe", image: "rebuildable", container: "rebuildable", volume: "takeALook" };

/** An image, container, volume or the build cache, removed through Docker. */
export const fromDocker = (item: DockerItem): TrayEntry => ({
  key: `docker:${item.kind}:${item.id}`,
  label: item.name,
  location: item.project ? `${item.detail} · ${item.project}` : item.detail,
  paths: [],
  size: item.size,
  risk: DOCKER_RISK[item.kind],
  category: "system",
  docker: { kind: item.kind, id: item.id },
});

/** Hue of each "What it is" kind, as in the design. */
export const KIND_HUES: Record<string, number> = {
  "App cache": 160,
  "Package cache": 200,
  "Update files": 100,
  "Build output": 250,
  Emulator: 230,
  SDK: 230,
  "AI models": 295,
  "Container data": 280,
  Logs: 80,
  "Your files": 30,
  Project: 320,
};

/** The short status shown next to a Docker item. */
export function dockerStatus(item: DockerItem): string {
  switch (item.kind) {
    case "buildCache":
      return "Unused";
    case "image":
      if (item.inUse) return "In use";
      if (item.stoppedContainers.length) return "Stopped container";
      return item.name.startsWith("<untagged>") ? "Dangling" : "Unused";
    case "container":
      return item.inUse ? "Running" : (item.detail.match(/Exited \(\d+\)/)?.[0] ?? "Stopped");
    case "volume":
      if (item.inUse) return "In use";
      if (item.anonymous) return "Anonymous";
      if (/node_modules|vendor|deps|packages/i.test(item.name)) return "Rebuildable";
      if (/cache|redis/i.test(item.name)) return "Cache";
      return "May be your data";
  }
}

/** The Docker entries of the tray, counted per kind: "3 images, 6 containers". */
export function dockerSummary(entries: TrayEntry[]): { label: string; size: number }[] {
  const names: [DockerItem["kind"], string, string][] = [
    ["image", "image", "images"],
    ["container", "container", "containers"],
    ["volume", "volume", "volumes"],
    ["buildCache", "build cache", "build cache"],
  ];
  return names.flatMap(([kind, one, many]) => {
    const of = entries.filter((e) => e.docker?.kind === kind);
    return of.length ? [{ label: `${of.length} ${of.length === 1 ? one : many}`, size: of.reduce((s, e) => s + e.size, 0) }] : [];
  });
}
