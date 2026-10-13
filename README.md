# Auto GitHub Sync (Minimal Obsidian Plugin)

Minimal plugin that automatically syncs vault changes to GitHub on desktop and mobile:

1. Watch vault file events (`create`, `modify`, `delete`, `rename`), debounced.
2. Commit local changes; push only if there is something to push (no network otherwise).
3. Pull on startup, when the app returns to the foreground, and on a configurable interval.
4. Flush pending changes when the app goes to the background (mobile).

## Conflicts

Sync never discards data:

- Non-overlapping edits are merged automatically (rebase on desktop, 3-way merge on mobile).
- When both devices edit the same lines (or a binary file), the remote version stays in place and the
  local version is saved next to it as `name (conflict YYYY-MM-DD HH-MM-SS).ext`.
- Edit vs. delete: the edited version is kept.
- Edits made while a sync is running are never overwritten by the incoming changes.

## Build

```bash
pnpm install
pnpm run build
```

## Notes

- Uses `isomorphic-git` with an Obsidian vault adapter so it can run on mobile too. Network requests go
  through Obsidian's `requestUrl`, so no third-party CORS proxy sees your token.
- Keeps the feature set intentionally small: no conflict UI (conflict copies instead), no advanced commands.
