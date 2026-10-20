import type { Category, TreeNode } from "./api";

/** Legend order, roughly from "yours" to "regenerable". */
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "media", label: "Documents & media" },
  { id: "code", label: "Code projects" },
  { id: "devTools", label: "Dev tools" },
  { id: "sdk", label: "iOS & Android SDKs" },
  { id: "aiModels", label: "AI models" },
  { id: "cache", label: "Caches & build output" },
  { id: "system", label: "Library & apps" },
  { id: "other", label: "Other" },
];

/** Bytes per category, each byte counted once at the deepest level we have. */
export function sizeByCategory(root: TreeNode): Map<Category, number> {
  const totals = new Map<Category, number>();
  const visit = (n: TreeNode) => {
    const childSum = n.children?.reduce((sum, c) => sum + c.size, 0) ?? 0;
    const own = Math.max(0, n.size - childSum);
    totals.set(n.category, (totals.get(n.category) ?? 0) + own);
    n.children?.forEach(visit);
  };
  visit(root);
  return totals;
}
