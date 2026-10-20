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

const riskOrder = (r: Risk) => RISKS.findIndex((x) => x.id === r);

/** The goal's picks: safest first, then largest, until the goal is met. */
export function autoPick(items: Recommendation[], goalBytes: number): string[] {
  const order = [...items].sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk) || b.size - a.size);
  const picked: string[] = [];
  let sum = 0;
  for (const item of order) {
    if (sum >= goalBytes) break;
    picked.push(item.id);
    sum += item.size;
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
