import type { App } from "obsidian";
import {
  conflictCopyPath,
  createCommitMessage,
  describeResult,
  type GitBackend,
  type SyncMode,
  type SyncResult,
} from "./gitBackend";
import type { AutoGitSyncSettings } from "./types";

type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined>; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type NodeModules = {
  child_process: { execFile: ExecFile };
  fs: {
    existsSync: (path: string) => boolean;
    promises: { copyFile: (from: string, to: string) => Promise<void> };
  };
  path: { join: (...parts: string[]) => string; resolve: (...parts: string[]) => string };
};

type NodeRequire = <K extends keyof NodeModules>(moduleName: K) => NodeModules[K];

type DesktopAdapter = {
  getBasePath?: () => string;
};

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
};

export class DesktopGitBackend implements GitBackend {
  private readonly vaultPath: string;
  private readonly node: { [K in keyof NodeModules]: NodeModules[K] };

  constructor(
    app: App,
    private readonly settings: AutoGitSyncSettings,
  ) {
    const adapter = app.vault.adapter as DesktopAdapter;
    const vaultPath = adapter.getBasePath?.();
    if (!vaultPath) {
      throw new Error("Could not determine the desktop vault path.");
    }

    const nodeRequire = this.getNodeRequire();
    this.node = {
      child_process: nodeRequire("child_process"),
      fs: nodeRequire("fs"),
      path: nodeRequire("path"),
    };
    this.vaultPath = vaultPath;
  }

  async sync(mode: SyncMode, trigger: string): Promise<SyncResult> {
    await this.ensureRepository();
    const branch = await this.getBranch();

    let committed = false;
    if (await this.hasChanges()) {
      await this.git(["add", "-A"]);
      await this.git(["commit", "-m", createCommitMessage(trigger)]);
      committed = true;
    }

    if (mode === "local" && !(await this.isAheadOfRemote(branch))) {
      return this.result({ pulled: false, committed, pushed: false, conflicts: [] });
    }

    const { pulled, conflicts } = await this.pullFromRemote(branch);
    let pushed = false;
    if (await this.isAheadOfRemote(branch)) {
      await this.pushWithRetry(branch, conflicts);
      pushed = true;
    }

    return this.result({ pulled, committed, pushed, conflicts });
  }

  private result(result: Omit<SyncResult, "message">): SyncResult {
    return { ...result, message: describeResult(result) };
  }

  private async ensureRepository(): Promise<void> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"], true);
    if (result.trim() !== "true") {
      throw new Error("This vault is not inside a Git repository.");
    }

    const mergeInProgress = await this.git(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      true,
    );
    if (mergeInProgress.trim() || (await this.gitPathExists("rebase-merge", "rebase-apply"))) {
      throw new Error(
        "A merge or rebase is in progress in the vault repository. Resolve it first.",
      );
    }
  }

  private async gitPathExists(...names: string[]): Promise<boolean> {
    for (const name of names) {
      const relative = (await this.git(["rev-parse", "--git-path", name])).trim();
      if (this.node.fs.existsSync(this.node.path.resolve(this.vaultPath, relative))) {
        return true;
      }
    }
    return false;
  }

  private async getBranch(): Promise<string> {
    const current = (await this.git(["branch", "--show-current"])).trim();
    if (!current) {
      throw new Error("The vault repository is in a detached HEAD state.");
    }

    const expected = this.settings.branch || current;
    if (current !== expected) {
      throw new Error(
        `Checked out branch "${current}" does not match the sync branch "${expected}".`,
      );
    }
    return current;
  }

  private async hasChanges(): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    return status.trim().length > 0;
  }

  private remoteRef(branch: string): string {
    return `${this.settings.remoteName}/${branch}`;
  }

  /** Compares against the last fetched remote-tracking ref (no network). */
  private async isAheadOfRemote(branch: string): Promise<boolean> {
    if (!(await this.hasRemoteBranch(branch))) {
      return (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], true)).trim() !== "";
    }
    const count = await this.git(["rev-list", "--count", `${this.remoteRef(branch)}..HEAD`]);
    return Number(count.trim()) > 0;
  }

  private async pullFromRemote(branch: string): Promise<{ pulled: boolean; conflicts: string[] }> {
    const before = await this.git(["rev-parse", "HEAD"], true);
    await this.git(["fetch", "--prune", this.settings.remoteName, branch], true);
    if (!(await this.hasRemoteBranch(branch))) {
      // Branch doesn't exist on the remote yet; a fetch failure would surface on push.
      return { pulled: false, conflicts: [] };
    }

    let conflicts: string[] = [];
    try {
      // --autostash protects edits made while the sync was running.
      await this.git(["rebase", "--autostash", this.remoteRef(branch)]);
    } catch {
      await this.git(["rebase", "--abort"], true);
      conflicts = await this.mergeKeepingBoth(branch);
    }

    const after = await this.git(["rev-parse", "HEAD"], true);
    return { pulled: before !== after, conflicts };
  }

  /**
   * Fallback when rebase hits conflicts: merge, and for every conflicting file keep the remote
   * version in place and save the local version next to it as a conflict copy. Nothing is lost.
   */
  private async mergeKeepingBoth(branch: string): Promise<string[]> {
    try {
      await this.git(["merge", "--no-edit", this.remoteRef(branch)]);
      return [];
    } catch (error) {
      const unmerged = this.splitNul(
        await this.git(["diff", "--name-only", "--diff-filter=U", "-z"], true),
      );
      if (unmerged.length === 0) {
        await this.git(["merge", "--abort"], true);
        throw error;
      }

      const stamp = new Date();
      const copied: string[] = [];
      for (const filepath of unmerged) {
        if (await this.resolveConflict(filepath, stamp)) copied.push(filepath);
      }
      await this.git(["commit", "--no-edit"]);
      return copied;
    }
  }

  /** Returns true when a conflict copy was written. */
  private async resolveConflict(filepath: string, stamp: Date): Promise<boolean> {
    const stages = new Set(
      this.splitNul(await this.git(["ls-files", "-u", "-z", "--", filepath])).map(
        (line) => line.split(/\s+/)[2],
      ),
    );
    const hasOurs = stages.has("2");
    const hasTheirs = stages.has("3");

    if (hasOurs && hasTheirs) {
      const copy = conflictCopyPath(filepath, stamp);
      await this.git(["checkout", "--ours", "--", filepath]);
      await this.node.fs.promises.copyFile(
        this.node.path.join(this.vaultPath, filepath),
        this.node.path.join(this.vaultPath, copy),
      );
      await this.git(["checkout", "--theirs", "--", filepath]);
      await this.git(["add", "--", filepath, copy]);
      return true;
    }
    if (hasOurs) {
      // Deleted remotely, modified locally: keep the local edit.
      await this.git(["add", "--", filepath]);
    } else if (hasTheirs) {
      // Deleted locally, modified remotely: keep the remote edit.
      await this.git(["checkout", "--theirs", "--", filepath]);
      await this.git(["add", "--", filepath]);
    } else {
      await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", filepath]);
    }
    return false;
  }

  private splitNul(output: string): string[] {
    return output.split("\0").filter((entry) => entry.length > 0);
  }

  private async hasRemoteBranch(branch: string): Promise<boolean> {
    const result = await this.git(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${this.remoteRef(branch)}`],
      true,
    );
    return result.trim().length > 0;
  }

  private async pushWithRetry(branch: string, conflicts: string[]): Promise<void> {
    try {
      await this.git(["push", this.settings.remoteName, `HEAD:refs/heads/${branch}`]);
    } catch {
      // Someone pushed in between; integrate and try once more.
      const retry = await this.pullFromRemote(branch);
      conflicts.push(...retry.conflicts);
      await this.git(["push", this.settings.remoteName, `HEAD:refs/heads/${branch}`]);
    }
  }

  private async git(args: string[], allowFailure = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.node.child_process.execFile(
        "git",
        args,
        {
          cwd: this.vaultPath,
          env: { ...this.processEnv(), ...GIT_ENV },
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && !allowFailure) {
            reject(new Error(stderr.trim() || error.message));
            return;
          }
          resolve(error ? "" : stdout);
        },
      );
    });
  }

  private processEnv(): Record<string, string | undefined> {
    const globalWithProcess = globalThis as typeof globalThis & {
      process?: { env: Record<string, string | undefined> };
    };
    return globalWithProcess.process?.env ?? {};
  }

  private getNodeRequire(): NodeRequire {
    const globalWithRequire = globalThis as typeof globalThis & {
      require?: NodeRequire;
    };

    if (!globalWithRequire.require) {
      throw new Error("Native Git is only available in the desktop app.");
    }

    return globalWithRequire.require;
  }
}
