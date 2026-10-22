<p align="center">
  <img src="design/icon.png" width="180" alt="Kurz icon: a fluffy dust bunny with big eyes">
</p>

<h1 align="center">Kurz</h1>

<p align="center">
  A macOS app that shows what's taking up space on your disk and helps you get it back, safely.
</p>

<p align="center">
  <i>Kurz</i> is Polish for <i>dust</i>.
</p>

<p align="center">
  <a href="https://github.com/MarcinSzyc/kurz/actions/workflows/ci.yml"><img src="https://github.com/MarcinSzyc/kurz/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

---

## What it does

Kurz scans your home folder, builds a size tree of every file and folder, suggests what's safe to remove, and shows a map where you can see at a glance where the dust gathers. The target design lives in [`design/`](design/).

| Feature | Status |
|---|---|
| Fast, parallel scan of the home folder with live progress and cancel | ✅ done |
| Opens with the last scan right away ("scanned 3 h ago"); a new scan runs while the old one stays on screen | ✅ done |
| Header disk bar: free space and usage | ✅ done |
| Light and dark themes: follows macOS by default; sun/moon toggle in the header, Light / Dark / Auto in the ••• menu | ✅ done |
| **Clean up** screen: an "I need X GB" goal fills the tray with the safest items first; three groups: *Safe to delete*, *Rebuildable*, *Take a look*; when each item last changed | ✅ done |
| "What is this?" under each item: the owning app, found locally through macOS (its name, whether it's installed and running), notes for opaque folders (e.g. `*.ShipIt` update files, the TypeScript cache); "Quit … first" and "App not installed" tags | ✅ done |
| What's inside Docker, under its row in Clean up: build cache, images, stopped containers and volumes (with their compose project), each removable on its own through Docker; in-use ones are kept | ✅ done |
| Cleaning that asks every time: to the Trash or permanently; Undo; "Empty from Trash" deletes only that cleanup's items | ✅ done |
| **Map** screen: a calm two-level treemap colored by category; clicking a tile adds the folder to the tray shared with Clean up; › opens a folder; "Only removable" dims folders that may hold your own files | ✅ done |
| **History** screen: space reclaimed, how fast the disk fills, a 30/90-day free space chart with cleanups marked, past cleanups with per-item restore from the Trash, folders that keep growing back | ✅ done |
| **Apps** screen: installed apps with version, vendor, App Store category, size plus leftovers in ~/Library, install date and last opened (Spotlight); filters, sort and search; uninstall an app with the leftovers you keep ticked; data left by apps that are gone | ✅ done |
| macOS menu bar gauge: four icon styles (Bar, Tank, Slabs, Sprite), configurable text, amber and coral past thresholds (80% and 95% by default) | ✅ done |
| **How it works** (from the ••• menu): scanning, categories, recommendation rules, protected places and removal, rendered from the same rules the app uses | ✅ done |
| Full Disk Access screen: checks whether Kurz has it, opens the right System Settings pane, Quit & Reopen; a banner after a scan with unreadable folders | ✅ done |
| Weekly auto-clean of folders that keep growing back | 📋 planned |
| A ready-made shell script instead of removing from the app | 📋 planned |
| Preferences, Check for updates (greyed out in the ••• menu) | 📋 planned |

### Safety rules

- **Every removal asks how:** move to the Trash (the default; Undo puts it back) or delete permanently (frees the space right away and can't be undone).
- Nothing happens until you choose it. Recommendations are only suggestions.
- Scanning only reads; it never changes anything on disk.
- Some places Kurz never touches: Documents, Desktop, Pictures, Movies, Music, iCloud Drive, Mail, Messages, Keychains, `~/.ssh`, `~/.gnupg`.
- Outside your home folder Kurz removes only app bundles, and only when you uninstall them: `*.app` in `/Applications` or `~/Applications`, never apps that are part of macOS, and a running app is asked to quit first (if it doesn't, it's skipped). Apps installed for all users (owned by `root`, typically by a `.pkg` installer) can only be removed as an administrator: Kurz asks once per cleanup through the macOS password dialog, as Finder does, and never sees the password. Moved to the Trash, such an app is handed back to you, so Undo and Empty from Trash work as usual.
- Nothing leaves your Mac. Kurz makes no network requests.

## How it works

```
┌─────────────────────────────── Kurz.app ────────────────────────────────┐
│                                                                         │
│  UI (React + TypeScript, in the system WebKit view)                     │
│    • Clean up, Map, History, the tray, the How it works and Menu bar    │
│      modals; treemap layout by d3-hierarchy                             │
│                 ▲ events: scan-progress, scan-done, cleanup-progress    │
│                 │ commands: start_scan, get_tree, get_recommendations,  │
│                 │           clean_up, restore_cleanup, get_history, …   │
│  Core (Rust)    ▼                                                       │
│    • scanner.rs     parallel directory walk (rayon), size tree in RAM   │
│    • rules.rs       cleanup rules and protected places                  │
│    • recommend.rs   matches the rules against the tree                  │
│    • about.rs       which app owns a folder, notes for opaque ones      │
│    • cleanup.rs     re-checks paths, moves to the Trash, deletes        │
│    • history.rs     cleanups, free space samples, sizes over time       │
│    • categories.rs  folder categories (map colors)                      │
│    • menubar.rs, gauge.rs  the menu bar item and its icon              │
│    • disk.rs, settings.rs  volume capacity, settings                    │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **Scan.** Rust walks the folders in parallel on every CPU core; each subfolder is a task for the rayon thread pool. Every 150 ms the UI gets a progress event: files, folders, bytes and errors so far.
2. **Sizes.** Kurz counts the space files actually take on disk (`st_blocks × 512`), the same number `du` reports, not their "logical" size, so sparse and compressed files aren't overcounted.
3. **Traps the scanner avoids:**
   - it never follows symlinks, so nothing is counted twice and there are no loops;
   - it skips other volumes mounted inside the scanned folder;
   - a file with several hard links counts once;
   - a folder it can't read is counted as unreadable and the scan goes on.
4. **The tree in memory.** The scan result is a tree in the Rust process. The UI fetches only the part it shows (`get_tree(path, depth)`); entries too small to see are merged into one, so even with millions of files little data crosses to the UI.
5. **Recommendations.** The rules in [`rules.rs`](src-tauri/src/rules.rs) describe what Kurz may suggest: a path, or a folder name with a condition (e.g. `node_modules` next to `package.json`, only in projects unchanged for 30 days), a risk level (*Safe*, *Rebuildable* or *Take a look*), why, and how to get it back. The protected places live in the same file, and tests make sure no rule reaches into them. Matching runs on the tree in memory, in milliseconds; once a folder matches, nothing inside it is matched again.
6. **What is this?** For app caches, [`about.rs`](src-tauri/src/about.rs) asks macOS (LaunchServices) which app has that bundle id, wherever it's installed, and whether it's running. Nothing is looked up online.
7. **Apps.** [`apps.rs`](src-tauri/src/apps.rs) reads each app in `/Applications` and `~/Applications` through `NSBundle` (name, version, vendor from the copyright line, App Store category), sizes it with the same scanner, finds its folders in `~/Library` by bundle id and name, and asks Spotlight (`mdls`) when it was added and last opened. When Spotlight has no record, the last change to the app's data stands in, marked with `~`. Data named after bundle ids of apps that are gone, from vendors with no app left, shows up as leftovers.
8. **Docker.** [`docker.rs`](src-tauri/src/docker.rs) talks to the Docker Engine API over its socket (`~/.docker/run/docker.sock`) with a few lines of plain HTTP: it asks for images, containers, volumes and build cache one kind at a time (`/system/df?type=…`), which keeps working while builds prune their cache, and removes them with the same API calls the `docker` CLI uses. Docker's own data is never deleted as files, which would corrupt it; Docker removes these for good, with no Trash.
9. **Removal.** Right before removing, each path is checked again: it still exists, it's inside your home folder even after resolving symlinks, and it isn't in a protected place. The Trash is handled by the system `NSFileManager`; Kurz remembers where each item landed in the Trash, so Undo and History can put it back.

**No database, and none needed.** A tree of ~3 million files fits in a few hundred MB of RAM and is rebuilt on every scan. Kurz writes two small JSON files in `~/Library/Application Support/com.marcinszyc.kurz/`: `settings.json` and `history.json` (cleanups, free space sampled at most hourly, recommendation sizes once a day; data older than 120 days is dropped). It also keeps the last scan in `~/Library/Caches/com.marcinszyc.kurz/last-scan.bin`, so it opens with it: every folder, files of 1 MB or more and the small files rules look for, gzip-compressed (a few MB for a home folder with millions of files; smaller files stay counted in their folder's size). Deleting it only means the next launch starts empty.

## Why these technologies

**Rust: the core and the scanner.** Scanning a disk means millions of system calls and a lot of CPU work. Rust gives:
- C-level speed without a garbage collector, which matters with millions of objects in the tree;
- safe multithreaded directory walking: a few lines with rayon, and the compiler rules out data races;
- direct access to system APIs (`statfs`, file metadata, `NSFileManager`, LaunchServices) without extra layers.

For example, scanning `~/Prywatne` (9.5 GB, 188k files) takes 2.3 s in a release build.

**Tauri 2: the app shell.** It joins the Rust core with a web UI:
- the app is small, about 5 MB, because it uses the WebKit built into macOS instead of shipping Chromium like Electron;
- Rust ↔ UI talk is plain commands and events;
- a permission system lets the UI do only what's explicitly allowed;
- Windows and Linux builds are possible if ever needed.

**React + TypeScript: the UI.** Interactive visualizations (the map, selection, panels) are easiest in web tech. TypeScript keeps the types in line with what Rust returns.

**d3-hierarchy: the map layout.** A proven squarified treemap implementation that splits a rectangle into tiles as close to square as possible. Only the layout math is used; React draws.

**Vite + pnpm: building the UI.** Vite gives an instant dev server with hot reload. pnpm is fast and saves disk space, which an app about saving disk space should appreciate.

## Build and install

### Requirements

- A Mac with Apple Silicon. Built and tested on macOS 15. The UI uses modern CSS (`oklch`, `color-mix`), so it needs the WebKit of Safari 16.4 or later.
- [Rust](https://rustup.rs) (stable):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- [Node.js](https://nodejs.org) 20 or later and [pnpm](https://pnpm.io)
- Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- About 12 GB of free disk space for the build (see [Size](#size)).

### Quick install

```bash
git clone https://github.com/MarcinSzyc/kurz.git
cd kurz
./scripts/install.sh
```

The script ([`scripts/install.sh`](scripts/install.sh), also `pnpm install:app`) installs dependencies, builds `Kurz.app`, signs it ad-hoc, quits a running Kurz, copies it into `/Applications` and opens it. Pass `--no-open` to skip opening it. To update later, pull and run it again. The steps below are what it does, if you'd rather do them by hand.

### Keep permissions across builds (once)

macOS remembers Full Disk Access per code signature, and an ad-hoc signature changes with every build, so each new build would ask again. Create a local signing certificate once, and every build keeps the same identity:

```bash
./scripts/setup-signing.sh
```

It adds a certificate named "Kurz Local Signing" to your login keychain and trusts it for code signing only; macOS asks for your password. `scripts/install.sh` then signs with it. Grant Full Disk Access one more time after the first build signed this way; later builds keep it. Remove the certificate any time in Keychain Access.

### 1. Get the code and dependencies

```bash
git clone https://github.com/MarcinSzyc/kurz.git
cd kurz
pnpm install
```

### 2. Build Kurz.app

```bash
pnpm tauri build --bundles app
```

This builds the UI, compiles Rust with optimizations and bundles the app. The first build takes about 3 minutes on an M-series Mac; later ones are faster. The result is:

```
src-tauri/target/release/bundle/macos/Kurz.app
```

Leave out `--bundles app` to also get a `.dmg` installer in `src-tauri/target/release/bundle/dmg/`.

### 3. Sign it locally

The build is unsigned for distribution. Give it an ad-hoc signature so macOS runs it as one consistent app:

```bash
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/Kurz.app
```

Check it:

```bash
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Kurz.app
```

It should say `valid on disk` and `satisfies its Designated Requirement`. An app you build and sign yourself isn't quarantined, so Gatekeeper lets it open. Sharing it with other people would need a Developer ID signature and notarization, which this project doesn't set up.

### 4. Install

If Kurz is running, quit it first: menu bar icon → **Quit Kurz**. Then copy it into Applications and open it:

```bash
ditto src-tauri/target/release/bundle/macos/Kurz.app /Applications/Kurz.app
```

```bash
open /Applications/Kurz.app
```

### Updating

Pull the new code and run `./scripts/install.sh` again, or repeat steps 2–4 by hand: build, sign, quit the running Kurz, copy, open. With an ad-hoc signature each build is a new app to macOS, so it asks again for folder access and Full Disk Access; set up the [local signing certificate](#keep-permissions-across-builds-once) once to avoid that.

### Uninstalling

Quit Kurz from the menu bar, then remove the app and, if you want, its settings and history:

```bash
rm -rf /Applications/Kurz.app
```

```bash
rm -rf ~/Library/Application\ Support/com.marcinszyc.kurz
```

### Size

| What | Size |
|---|---|
| `Kurz.app` on disk | **5.1 MB** (4.6 MB executable, 0.5 MB resources) |
| Architecture | arm64 (Apple Silicon) |
| Memory at rest, before a scan | about 58 MB |
| Memory after scanning a home folder with ~3 million files | a few hundred MB, freed on quit |
| Build output in `src-tauri/target` (debug + release) | about 11 GB |

The build output is only needed to build again. To get that space back, which is the point of Kurz after all:

```bash
cd src-tauri && cargo clean
```

## Development

### Run in development mode

```bash
pnpm install
pnpm tauri dev
```

This opens the app window and reloads it when you change the UI or the Rust code. A dev build scans several times slower than a release build.

### Tests

```bash
cd src-tauri && cargo test
```

```bash
pnpm test
```

The first runs the Rust tests (scanner, rules, cleanup checks, history, icons…); the second the UI logic with [Vitest](https://vitest.dev): how the goal fills the tray, how a folder's risk is decided, how entries replace what they contain.

```bash
cd src-tauri && cargo clippy --all-targets
```

```bash
pnpm build
```

The last one type-checks and builds the UI. [CI](.github/workflows/ci.yml) runs all of these on every push, on macOS.

### Benchmark the scanner from the command line

```bash
cd src-tauri && cargo run --release --example scan -- ~/Projects
```

It prints the scan time, the largest entries and the recommendations.

### Look at the menu bar icons

```bash
cd src-tauri && KURZ_ICON_SHEET=/tmp/kurz-icons.png cargo test icon_sheet -- --ignored
```

It writes every icon style at each level into one PNG.

## Menu bar

Kurz shows a small disk gauge in the macOS menu bar in one of four styles (a bar, a tank, three slabs, or the Kurz sprite with a dot) next to a short text: percent used, used of total, or free space. Below the first threshold the icon is monochrome like other menu bar icons; from 80% it turns amber, from 95% coral. The text stays in the system color, as macOS doesn't let apps color it. Style, text, thresholds and refresh rate are in **••• → Menu bar…**.

With the menu bar item on, closing the window only hides it and Kurz keeps running in the menu bar. Open the window again from the menu bar item or the Dock icon. To quit, choose **Quit Kurz** in the menu bar item.

## macOS permissions

On the first scan macOS asks for access to Desktop, Documents and Downloads. To scan everything, including app data in `~/Library`, give Kurz Full Disk Access: **System Settings → Privacy & Security → Full Disk Access**. Without it some folders show up as unreadable.

Without Full Disk Access macOS also asks once whether Kurz may read other apps' data (`~/Library/Containers`); until you answer, that part of a scan waits.

Kurz walks you through it: before the first scan, and from a banner when a scan found unreadable folders, it opens that pane for you and offers **Quit & Reopen**, since macOS applies the change only after a restart. To tell whether access is on, Kurz tries to open the macOS privacy database (`~/Library/Application Support/com.apple.TCC/TCC.db`), which only apps with Full Disk Access may open; it never reads or changes it.

## Project structure

```
kurz/
├── src/                    # UI (React + TypeScript)
│   ├── App.tsx             # header, tabs, shared tray state
│   ├── components/         # CleanUp, DockerPanel, MapView, HistoryView, AppsView,
│   │                       # Tray, HeaderMenu, MenuBarSettings, HowItWorks, FullDiskAccess
│   ├── lib/                # calls into Rust, the tray model, formatting
│   └── assets/             # app icon, Geist fonts (SIL OFL)
├── src-tauri/              # core (Rust)
│   ├── src/scanner.rs      # parallel scanner + tests
│   ├── src/rules.rs        # cleanup rules and protected places
│   ├── src/recommend.rs    # matching the rules against a scan
│   ├── src/about.rs        # "what is this": owning app, notes for opaque folders
│   ├── src/apps.rs         # installed apps, their data, leftovers of removed apps
│   ├── src/docker.rs       # what's inside Docker, removed through its API
│   ├── src/cleanup.rs      # path checks, Trash, delete, restore
│   ├── src/history.rs      # cleanups, free space, sizes over time (JSON)
│   ├── src/cache.rs        # the last scan, saved compactly for the next launch
│   ├── src/categories.rs   # folder categories
│   ├── src/menubar.rs      # the menu bar item
│   ├── src/gauge.rs        # drawing the menu bar icon
│   ├── src/disk.rs         # volume capacity
│   ├── src/access.rs       # Full Disk Access check, System Settings pane
│   ├── src/settings.rs     # settings (JSON)
│   ├── src/lib.rs          # Tauri commands and events
│   ├── examples/scan.rs    # command-line benchmark
│   └── tauri.conf.json     # window and bundle configuration
├── scripts/install.sh      # build, sign and install Kurz.app
├── scripts/setup-signing.sh # a local signing certificate, so builds keep permissions
└── design/                 # target designs (HTML mockups) and the icon
```

## How this project is built

Kurz is built agentically, with an AI agent (Claude Code), **on plain prompts**:

- **No skills.** No ready-made skills or custom instruction sets for the agent. Every step is a plain conversation: what we want, a screenshot, or a note about the result.
- **No wiki.** No separate knowledge base or docs for the agent. The source of truth is the code, the tests, the git history and this README.
- **Lightweight.** The app should stay small and fast: minimal dependencies, no database, no server, no heavy frameworks. Every new dependency has to earn its place.

We work in small steps: plan, implement, test, commit. Every commit is marked as co-authored with the agent.

## Icon

A fluffy dust bunny with big eyes, in the spirit of Studio Ghibli films. It's original artwork drawn in SVG for this project: [`design/icon.svg`](design/icon.svg).
