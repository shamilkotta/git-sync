import type { App } from "obsidian";
import type { GitBackend, SyncMode, SyncResult } from "./gitBackend";
import type { AutoGitSyncSettings } from "./types";

type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type NodeRequire = (moduleName: "node:child_process" | "child_process") => {
  execFile: ExecFile;
};

type DesktopAdapter = {
  getBasePath?: () => string;
};

export class DesktopGitBackend implements GitBackend {
  private readonly vaultPath: string;
  private readonly execFile: ExecFile;

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
    this.execFile = nodeRequire("child_process").execFile;
    this.vaultPath = vaultPath;
  }

  async sync(mode: SyncMode, trigger: string): Promise<SyncResult> {
    await this.ensureRepository();

    const branch = await this.getBranch();
    await this.git(["pull", "--ff-only", this.settings.remoteName, branch]);

    if (mode === "startup") {
      const hasChanges = await this.hasChanges();
      if (!hasChanges) {
        return {
          pulled: true,
          committed: false,
          pushed: false,
          message: "Pulled latest changes.",
        };
      }
    }

    const hasChanges = await this.hasChanges();
    if (!hasChanges) {
      return {
        pulled: true,
        committed: false,
        pushed: false,
        message: "Already up to date.",
      };
    }

    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", this.createCommitMessage(trigger)]);
    await this.git(["push", this.settings.remoteName, branch]);

    return {
      pulled: true,
      committed: true,
      pushed: true,
      message: "Committed and pushed vault changes.",
    };
  }

  private async ensureRepository(): Promise<void> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"], true);
    if (result.trim() !== "true") {
      throw new Error("This vault is not inside a Git repository.");
    }
  }

  private async getBranch(): Promise<string> {
    if (this.settings.branch) {
      return this.settings.branch;
    }

    const branch = await this.git(["branch", "--show-current"]);
    if (!branch.trim()) {
      throw new Error("Could not determine the current Git branch.");
    }
    return branch.trim();
  }

  private async hasChanges(): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    return status.trim().length > 0;
  }

  private async git(args: string[], allowFailure = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.execFile("git", args, { cwd: this.vaultPath }, (error, stdout, stderr) => {
        if (error && !allowFailure) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        if (error) {
          resolve("");
          return;
        }

        resolve(stdout);
      });
    });
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

  private createCommitMessage(trigger: string): string {
    return `vault sync: ${trigger} @ ${new Date().toISOString()}`;
  }
}
