/**
 * - `full`: always fetch/merge from the remote, then push anything local.
 * - `local`: commit local changes; only touch the network when there is something to push.
 *   Used for vault change events so our own writes (pulls) don't cause sync loops.
 */
export type SyncMode = "full" | "local";

export type SyncResult = {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  conflicts: string[];
  message: string;
};

export interface GitBackend {
  sync(mode: SyncMode, trigger: string): Promise<SyncResult>;
}

export function createCommitMessage(trigger: string): string {
  return `vault sync: ${trigger} @ ${new Date().toISOString()}`;
}

/** `notes/a.md` -> `notes/a (conflict 2026-10-13 14-03-12).md` */
export function conflictCopyPath(filepath: string, date = new Date()): string {
  const slash = filepath.lastIndexOf("/");
  const dir = filepath.slice(0, slash + 1);
  const name = filepath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = date.toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "-");
  return `${dir}${base} (conflict ${stamp})${ext}`;
}

export function describeResult(result: Omit<SyncResult, "message">): string {
  const parts: string[] = [];
  if (result.pulled) parts.push("pulled remote changes");
  if (result.committed) parts.push("committed local changes");
  if (result.pushed) parts.push("pushed");
  if (result.conflicts.length > 0) {
    parts.push(`kept ${result.conflicts.length} conflicting file(s) as conflict copies`);
  }
  if (parts.length === 0) return "Already up to date.";
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
