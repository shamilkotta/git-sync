# Auto GitHub Sync (Minimal Obsidian Plugin)

Minimal plugin that automatically syncs vault changes to GitHub on desktop and mobile:

1. Watch vault file events (`create`, `modify`, `delete`, `rename`).
2. Debounce frequent changes.
3. Optionally pull from remote.
4. Stage changed files.
5. Commit with an auto-generated message.
6. Push to remote branch.

## Build

```bash
pnpm install
pnpm run build
```

## Notes

- Uses `isomorphic-git` with an Obsidian vault adapter so it can run on mobile too.
- Keeps the feature set intentionally small: no conflict UI, no advanced commands.
