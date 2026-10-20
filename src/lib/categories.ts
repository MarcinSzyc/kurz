import type { Category } from "./api";

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
