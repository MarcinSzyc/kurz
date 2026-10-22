import { describe, expect, it } from "vitest";
import type { InstalledApp, Recommendation, Risk, TreeNode } from "./api";
import { GB, addEntry, ago, autoPick, covers, fromApp, fromDocker, fromFolder, fromLeftover, fromRecommendation, items, riskOfFolder } from "./tray";

const rec = (id: string, risk: Risk, gb: number, path = `/Users/me/${id}`): Recommendation => ({
  id,
  rule: id,
  label: id,
  risk,
  category: "cache",
  location: "~/" + id,
  paths: [path],
  size: gb * GB,
  modified: 0,
  about: "",
  owner: null,
});

const node = (path: string, category: TreeNode["category"], name = path.split("/").pop()!): TreeNode => ({
  name,
  path,
  kind: "dir",
  category,
  size: GB,
  files: 10,
  protected: false,
  children: null,
});

describe("autoPick", () => {
  const recs = [
    rec("spotify", "safe", 5.1),
    rec("google", "safe", 4.8),
    rec("npm", "safe", 3.7),
    rec("logs", "safe", 0.9),
    rec("docker", "rebuildable", 87),
    rec("avd", "rebuildable", 0.6),
    rec("repo", "takeALook", 2),
  ];
  const total = (ids: string[]) => recs.filter((r) => ids.includes(r.id)).reduce((s, r) => s + r.size, 0);

  it("picks nothing for no goal", () => {
    expect(autoPick(recs, 0)).toEqual([]);
  });

  it("takes the safe group first, largest first", () => {
    expect(autoPick(recs, 10 * GB)).toEqual(["spotify", "google", "logs"]);
  });

  it("covers a small shortfall with the smallest item that's enough, not the largest", () => {
    // Safe adds up to 14.5 GB; 0.5 GB short of 15 must not pull in 87 GB of Docker.
    const picked = autoPick(recs, 15 * GB);
    expect(picked).toContain("avd");
    expect(picked).not.toContain("docker");
    expect(total(picked)).toBeGreaterThanOrEqual(15 * GB);
  });

  it("only reaches for review items when nothing safer is left", () => {
    expect(autoPick(recs, 100 * GB)).not.toContain("repo");
    expect(autoPick(recs, 103 * GB)).toContain("repo");
  });
});

describe("covers", () => {
  const entry = fromRecommendation(rec("cache", "safe", 1, "/Users/me/Library/Caches"));
  it("matches the path and anything inside, not look-alike siblings", () => {
    expect(covers(entry, "/Users/me/Library/Caches")).toBe(true);
    expect(covers(entry, "/Users/me/Library/Caches/Google")).toBe(true);
    expect(covers(entry, "/Users/me/Library/CachesOld")).toBe(false);
  });
});

describe("addEntry", () => {
  const recs = [rec("spotify", "safe", 5, "/Users/me/Library/Caches/com.spotify.client"), rec("npm", "safe", 3, "/Users/me/.npm/_cacache")];

  it("replaces what the new folder contains, so nothing counts twice", () => {
    const inner = fromFolder(node("/Users/me/Library/Caches/Google", "cache"), "/Users/me", recs);
    const caches = fromFolder(node("/Users/me/Library/Caches", "cache"), "/Users/me", recs);

    const next = addEntry([inner], ["spotify", "npm"], recs, caches);

    expect(next.extras.map((e) => e.key)).toEqual([caches.key]);
    expect(next.selected).toEqual(["npm"]);
  });
});

describe("riskOfFolder", () => {
  const docker = rec("docker", "rebuildable", 80, "/Users/me/Library/Containers/com.docker.docker");

  it("takes the risk of a recommendation it is inside", () => {
    expect(riskOfFolder(node("/Users/me/Library/Containers/com.docker.docker/Data", "system"), [docker])).toBe("rebuildable");
  });

  it("takes the most cautious risk of the recommendations filling most of it", () => {
    const containers = { ...node("/Users/me/Library/Containers", "system"), size: 84 * GB };
    expect(riskOfFolder(containers, [docker])).toBe("rebuildable");
  });

  it("falls back to the category", () => {
    expect(riskOfFolder(node("/Users/me/.cache/x", "cache"), [])).toBe("safe");
    expect(riskOfFolder(node("/Users/me/.android", "sdk"), [])).toBe("rebuildable");
    expect(riskOfFolder(node("/Users/me/Projects/app", "code"), [])).toBe("takeALook");
    expect(riskOfFolder(node("/Users/me/Projects/app/node_modules", "cache"), [])).toBe("rebuildable");
  });
});

describe("fromApp", () => {
  const app: InstalledApp = {
    id: "com.example.app",
    name: "Example",
    version: "1.0",
    vendor: "Example Inc.",
    category: null,
    parts: [
      { kind: "Application", path: "/Applications/Example.app", size: 100 },
      { kind: "Caches", path: "/Users/me/Library/Caches/com.example.app", size: 50 },
      { kind: "Preferences", path: "/Users/me/Library/Preferences/com.example.app.plist", size: 1 },
    ],
    installed: null,
    lastOpened: null,
    lastOpenedEstimated: false,
    running: true,
    appStore: false,
    ownUninstaller: false,
    needsAdmin: true,
  };

  it("leaves out the parts the user keeps, never the app itself", () => {
    const entry = fromApp(app, ["/Users/me/Library/Preferences/com.example.app.plist", "/Applications/Example.app"]);
    expect(entry.paths).toEqual(["/Applications/Example.app", "/Users/me/Library/Caches/com.example.app"]);
    expect(entry.size).toBe(150);
    expect(entry.location).toBe("App + 1 leftover folder");
    expect(entry.risk).toBe("takeALook");
  });

  it("says Kurz will ask it to quit, and that a password is needed", () => {
    const entry = fromApp(app, []);
    expect(entry.quitsApp).toBe("Example");
    expect(entry.note).toContain("installed for all users");
  });
});

describe("fromLeftover", () => {
  it("is safe and keeps all its paths", () => {
    const e = fromLeftover({ id: "com.hnc.Discord", guess: "Discord", location: "~/x", paths: ["/a", "/b"], size: 7, modified: 0 });
    expect([e.label, e.risk, e.paths.length]).toEqual(["Discord leftovers", "safe", 2]);
  });
});

describe("labels", () => {
  it("counts items", () => {
    expect([items(1), items(3)]).toEqual(["1 item", "3 items"]);
  });

  it("says how long ago", () => {
    const now = 1_800_000_000;
    expect(ago(now, now)).toBe("today");
    expect(ago(now - 3 * 86_400, now)).toBe("3 d ago");
    expect(ago(now - 21 * 86_400, now)).toBe("3 wk ago");
    expect(ago(now - 120 * 86_400, now)).toBe("4 mo ago");
    expect(ago(now - 500 * 86_400, now)).toBe("1.4 yr ago");
  });
});

describe("fromDocker", () => {
  const item = (kind: "image" | "container" | "volume" | "buildCache") => ({
    kind,
    id: "x1",
    name: "n",
    detail: "d",
    size: 5,
    created: 0,
    inUse: false,
    project: "shop",
    anonymous: false,
  });

  it("rates volumes as possibly your data, build cache as safe", () => {
    expect(fromDocker(item("buildCache")).risk).toBe("safe");
    expect(fromDocker(item("image")).risk).toBe("rebuildable");
    expect(fromDocker(item("volume")).risk).toBe("takeALook");
    expect(fromDocker(item("volume")).location).toBe("d · shop");
  });

  it("is never pushed out of the tray by a folder", () => {
    const vol = fromDocker(item("volume"));
    const folder = fromFolder(node("/Users/me/Library", "system"), "/Users/me", []);
    expect(addEntry([vol], [], [], folder).extras.map((e) => e.key)).toEqual([vol.key, folder.key]);
  });
});
