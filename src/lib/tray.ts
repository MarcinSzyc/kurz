import type { Recommendation, Risk } from "./api";

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
