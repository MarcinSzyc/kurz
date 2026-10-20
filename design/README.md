# Design

[`mockup.html`](mockup.html) is the target design for Kurz: a self-contained page (open it in a browser) with three screens, each in light and dark.

| Screen | Mockup | What it does |
|---|---|---|
| **Clean up** | 5a (light), 7a (dark) | "I need 30 GB": a goal slider fills the cleanup tray with the safest, biggest items first. Items are grouped as **Safe to delete**, **Rebuildable** and **Take a look**, each with its path, size and when it last changed. Add or remove items by hand, then *Review & clean*. |
| **Map** | 6a, 7b | Calm treemap, two levels deep, small folders merged. Clicking a tile adds it to the same tray; *Only removable* dims folders that may hold your own files. |
| **History** | 6b, 7c | Free space over 30/90 days with cleanups marked, past cleanups with *Restore* while still in the Trash, and folders that keep growing back, with weekly auto-clean. |

Shared pieces:

- **Header:** app name and home path, tabs *Clean up / Map / History*, a disk bar with free space, *Scan again*.
- **Cleanup tray** (right column): total selected, free space before → after, the items with their risk badge, *Review & clean*.
- **Confirm sheet:** the selection summed up by risk, and the choice every time: *Move to Trash* (default) or *Delete permanently*.
- **After cleaning:** a toast with *Undo*; the tray offers *Empty Trash* to free the space for good.

Palette: warm paper (`#f5f3ef` / cards `#fbfaf7`) in light, `#141413` / `#1b1b1a` in dark; calm `oklch` tints per category; green for freed space, terracotta for low space.
